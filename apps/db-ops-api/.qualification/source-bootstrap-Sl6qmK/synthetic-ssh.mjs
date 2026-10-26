import ssh2 from 'ssh2';
const original=ssh2.Client.prototype.connect;
ssh2.Client.prototype.connect=function(c){
 if(c.host!=='192.168.49.130'||c.port!==22)throw Error('UNEXPECTED_TEST_SSH_TARGET');
 return original.call(this,{...c,host:'127.0.0.1',port:62559});
};
