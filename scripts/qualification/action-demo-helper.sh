#!/bin/sh
# Install root:root 0755 at /usr/local/libexec/slide-action-demo-helper.
# sudoers: slide-action ALL=(root) NOPASSWD: /usr/local/libexec/slide-action-demo-helper
# Keep sudo env_reset, !setenv, no shell/other sudo grants; disable SSH forwarding,
# PTY, password login and user rc for this dedicated nonroot account.
# Registration and state directories MUST be provisioned root-owned beforehand.
exec /usr/bin/env -i PATH=/usr/bin:/bin SUDO_USER="${SUDO_USER-}" /usr/bin/python3 -I - "$@" <<'PY'
import os, sys, json, hashlib, stat, re, subprocess, fcntl, uuid
HELPER = '/usr/local/libexec/slide-action-demo-helper'
REGISTRATION = '/etc/slide-action-demo/registration.json'
STATE = '/var/lib/slide-action-demo'
UNIT = 'slide-action-demo.service'
UNIT_FILE = '/etc/systemd/system/slide-action-demo.service'
SYSTEMCTL = '/usr/bin/systemctl'

def check_path(path, directory=False):
    parts = path.split('/')[1:]
    current = ''
    for index, part in enumerate(parts):
        current += '/' + part
        s = os.lstat(current)
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('ownership')
        if index < len(parts)-1 and not stat.S_ISDIR(s.st_mode):
            raise ValueError('ancestor')
    if directory and not stat.S_ISDIR(s.st_mode):
        raise ValueError('directory')
    if not directory and not stat.S_ISREG(s.st_mode):
        raise ValueError('file')

def canonical(v):
    return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()

def digest(path):
    check_path(path)
    with open(path,'rb') as f: return hashlib.sha256(f.read()).hexdigest()

def ctl(*args):
    return subprocess.run([SYSTEMCTL,*args],capture_output=True,text=True,timeout=65,check=True).stdout.strip()

def invocation():
    value = ctl('show',UNIT,'--property=InvocationID','--value')
    if not re.fullmatch('[a-f0-9]{32}',value): raise ValueError('invocation')
    return value

def configuration():
    check_path(REGISTRATION)
    with open(REGISTRATION) as f: r=json.load(f)
    keys={'protocol','serverId','host','port','username','unit','helper','helperHash','unitHash','hostFingerprint','toolVersion','eligible'}
    if set(r)!=keys or r['protocol']!=1 or type(r['serverId']) is not int or r['serverId']<=0 or r['host']!='192.168.49.130' or r['port']!=22 or r['username']!='slide-action' or r['unit']!=UNIT or r['helper']!=HELPER or r['toolVersion']!='1' or r['eligible'] is not True:
        raise ValueError('registration')
    if not re.fullmatch('SHA256:[A-Za-z0-9+/]{43}',r['hostFingerprint']): raise ValueError('fingerprint')
    if digest(HELPER)!=r['helperHash'] or digest(UNIT_FILE)!=r['unitHash']: raise ValueError('hash')
    if ctl('show',UNIT,'--property=FragmentPath','--value')!=UNIT_FILE or ctl('show',UNIT,'--property=DropInPaths','--value'):
        raise ValueError('unit overrides')
    for prop,expected in [('Id',UNIT),('LoadState','loaded'),('NeedDaemonReload','no'),('Transient','no')]:
        if ctl('show',UNIT,'--property='+prop,'--value')!=expected: raise ValueError('effective unit')
    return r,hashlib.sha256(canonical(r)).hexdigest()

def persist(path, value):
    # New root-only temporary inode, fsync data and directory before returning.
    tmp = STATE+'/.tmp-'+str(uuid.uuid4())
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(canonical(value)); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
        d=os.open(STATE,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(d)
        finally: os.close(d)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def read_receipt(path, op, plan, config, helper):
    check_path(path)
    with open(path) as f: r=json.load(f)
    if r.get('operationId')!=op or r.get('planHash')!=plan or r.get('configHash')!=config or r.get('helperHash')!=helper or r.get('unit')!=UNIT:
        raise ValueError('operation collision')
    return r

def main():
    args=sys.argv[1:]
    if args==['inspect']: mode='inspect'
    elif len(args)==5 and args[0] in ('execute','receipt') and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',args[1]) and all(re.fullmatch('[a-f0-9]{64}',v) for v in args[2:]): mode=args[0]
    else: raise ValueError('arguments')
    if os.geteuid()!=0 or os.environ.get('SUDO_USER')!='slide-action': raise ValueError('principal')
    r,config=configuration()
    if mode=='inspect':
        print(json.dumps({'protocol':1,'configHash':config,'helperHash':r['helperHash'],'unitHash':r['unitHash'],'serverId':r['serverId'],'unit':UNIT,'invocationId':invocation()})); return
    _,op,plan,expected_config,expected_helper=args
    if expected_config!=config or expected_helper!=r['helperHash']: raise ValueError('binding')
    check_path(STATE,True)
    lockpath=STATE+'/.lock'
    lockfd=os.open(lockpath,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    if os.fstat(lockfd).st_uid!=0 or os.fstat(lockfd).st_mode & 0o077: raise ValueError('lock ownership')
    with os.fdopen(lockfd,'r+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        path=STATE+'/'+op+'.json'
        if os.path.lexists(path):
            # A persisted intent is UNKNOWN forever until a trusted completed
            # receipt exists. Repeated execute ONLY reads; never restarts.
            print(json.dumps(read_receipt(path,op,plan,config,r['helperHash']))); return
        if mode=='receipt': print('null'); return
        # Prevent a new operation bypassing an unresolved previous intent.
        for name in os.listdir(STATE):
            if name.endswith('.json'):
                check_path(STATE+'/'+name)
                with open(STATE+'/'+name) as f: previous=json.load(f)
                if previous.get('outcome')=='outcome_unknown': raise ValueError('unresolved operation')
        before=invocation()
        receipt={'protocol':1,'operationId':op,'planHash':plan,'unit':UNIT,'configHash':config,'helperHash':r['helperHash'],'outcome':'outcome_unknown','before':before,'after':None}
        persist(path,receipt)  # DURABLE SEND BOUNDARY; crash from here NEVER retries.
        try:
            ctl('restart',UNIT)
            after=invocation()
            if after!=before and ctl('is-active',UNIT)=='active':
                completed=dict(receipt,outcome='succeeded',after=after)
                persist(path,completed)
                receipt=completed
        except Exception:
            pass  # Timeout/nonzero does not prove no restart: preserve unknown.
        print(json.dumps(receipt))
try:
    main()
except Exception:
    print('ACTION_HELPER_REFUSED_OR_UNAVAILABLE',file=sys.stderr)
    sys.exit(1)
PY
