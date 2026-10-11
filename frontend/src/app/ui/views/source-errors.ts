import { html, nothing } from 'lit';
import '../components/app-notice.js';

export type SourceRecovery = 'token' | 'config' | 'reload' | 'retry' | 'admin' | 'sync' | 'none';
export interface SourceError { code: string; message: string; recovery: SourceRecovery; detail?: string }
const entry = (message: string, recovery: SourceRecovery, detail?: string) => ({ message, recovery, detail });
// This bounded catalog is shared by the configuration form and snapshot view.
export const sourceErrors: Record<string, Omit<SourceError, 'code'>> = {
  SOURCE_SIGNING_KEY_INVALID: entry('服务端源码快照签名配置不完整，请联系管理员检查配置后重试', 'admin', '管理员需检查 SLIDE_SOURCE_SIGNING_KEY，至少 32 字节；请勿公开密钥。'),
  SOURCE_CREDENTIAL_INVALID: entry('无法读取{platform}仓库，令牌可能已过期、被撤销或缺少仓库读取权限。请输入新令牌后同步；需要保留时点击“替换已保存令牌”。', 'token'),
  SOURCE_CREDENTIAL_EXPIRED: entry('本次源码同步授权窗口已结束，请重新输入令牌后同步；这不代表平台令牌已过期。', 'token'),
  SOURCE_UPSTREAM_FORBIDDEN: entry('{platform}拒绝读取仓库，可能是令牌无效、缺少读取权限或平台访问策略限制。请检查权限，必要时输入新令牌。', 'token'),
  SOURCE_UPSTREAM_PERMISSION_DENIED: entry('{platform}明确拒绝仓库读取权限，请检查令牌的仓库范围和读取权限后重新同步。', 'token'),
  SOURCE_UPSTREAM_RATE_LIMITED: entry('{platform}暂时限制访问频率，请稍后重新同步。', 'retry'),
  SOURCE_REPOSITORY_NOT_FOUND: entry('无法找到或读取{platform}仓库，请检查仓库路径及令牌读取权限；私有仓库无权访问也可能返回此错误。', 'config'),
  SOURCE_REF_NOT_FOUND: entry('无法读取指定分支、标签或提交，请修正引用并保存配置后重新同步。', 'config'),
  SOURCE_REF_INVALID: entry('分支、标签或提交格式不正确，请修正对应字段并保存。', 'config'),
  SOURCE_CONFIG_INVALID: entry('源码仓库配置不正确，请检查平台地址、仓库路径、Git 用户名、代理和源码目录格式后保存。', 'config'),
  SOURCE_REPOSITORY_PATH_REQUIRED: entry('旧 GitLab 数字 ID 已失效，请重新填写平台地址和仓库路径并保存。', 'config'),
  SOURCE_ORIGIN_DENIED: entry('平台地址格式不正确或不在服务端允许范围，请检查实例根地址；需要新增地址时联系管理员。', 'config'),
  SOURCE_CONFIG_CHANGED: entry('仓库配置已发生变化，请加载最新配置并核对后保存；当前未保存输入会保留。', 'reload'),
  SOURCE_NOT_CONFIGURED: entry('尚未配置源码仓库。请先填写平台地址和仓库路径并保存。', 'config'),
  SOURCE_NOT_SYNCED: entry('当前仓库和分支尚未同步，请先同步源码。', 'sync'),
  SOURCE_SAVED_CREDENTIAL_UNAVAILABLE: entry('已保存令牌无法解密，请输入新令牌并替换已保存令牌；仍失败时联系管理员检查加密配置。', 'token'),
  SOURCE_CREDENTIAL_ENCRYPTION_UNAVAILABLE: entry('服务端令牌加密配置不可用，请联系管理员检查加密密钥后重试。', 'admin'),
  SOURCE_STORAGE_UNAVAILABLE: entry('服务端源码存储不可用，请联系管理员检查数据库和存储后重试。', 'admin'),
  SOURCE_SNAPSHOT_UNTRUSTED: entry('源码快照校验未通过，暂时无法读取。请联系管理员检查签名和存储，确认后重新同步。', 'admin'),
  SOURCE_SNAPSHOT_POLICY_CHANGED: entry('源码读取策略已变化，请核对并保存配置后重新同步。', 'config'),
  SOURCE_COMMIT_MISMATCH: entry('获取的提交与预期不一致，请检查提交引用后重新同步。', 'config'),
  SOURCE_SYNC_DEADLINE: entry('源码同步超时，请检查网络或代理后重新同步。', 'retry'),
  SOURCE_UPSTREAM_UNAVAILABLE: entry('无法连接代码托管平台，请检查网络、代理或 TLS 证书后重新同步。', 'retry'),
  SOURCE_SYNC_BUSY: entry('服务端正在同步源码，请等待当前同步结束后重试。', 'retry'),
  SOURCE_READ_BUSY: entry('源码读取请求繁忙，请稍后重试。', 'retry'),
  SOURCE_RATE_LIMITED: entry('源码请求过于频繁，请稍后重试。', 'retry'),
  SOURCE_ADMIN_REQUIRED: entry('当前账号没有源码管理权限，请联系管理员。', 'none'),
  SOURCE_READ_FORBIDDEN: entry('当前账号没有源码读取权限，请联系管理员。', 'none'),
  SOURCE_MODEL_EGRESS_DENIED: entry('当前配置未允许模型读取源码，请由管理员检查模型读取设置。', 'none'),
  SOURCE_PATH_NOT_ALLOWED: entry('文件不在允许读取的源码目录内，请检查源码范围配置。', 'config'),
  SOURCE_PATH_INVALID: entry('源码文件路径不受支持，请选择允许目录内的文本源码文件。', 'none'),
  SOURCE_QUERY_INVALID: entry('源码搜索条件不正确，请修正搜索条件。', 'none'),
  SOURCE_SYMBOL_INVALID: entry('源码符号名称不正确，请修正名称。', 'none'),
  SOURCE_REGION_INVALID: entry('源码行号范围不正确，请修正起止行号。', 'none'),
  SOURCE_REGION_TOO_LARGE: entry('源码读取范围过大，请缩小行号范围。', 'none'),
  SOURCE_FILE_COUNT_INVALID: entry('没有可同步的源码文件或文件数量超限，请调整允许的源码目录并保存。', 'config'),
  SOURCE_SNAPSHOT_TOO_LARGE: entry('源码快照超过 32MiB 容量上限，请缩小允许的源码目录后重新同步。', 'config'),
  SOURCE_FILE_TOO_LARGE: entry('源码文件超过容量上限，请缩小同步范围。', 'config'),
  SOURCE_BINARY_FILE: entry('该文件不是可读取的文本源码，请选择其他文件。', 'none'),
  SOURCE_CONTENT_INVALID: entry('源码内容无法读取，请联系管理员检查快照存储。', 'admin'),
  SOURCE_DUPLICATE_PATH: entry('源码快照存在重复路径，请联系管理员检查同步结果。', 'admin'),
  SOURCE_IDENTITY_INVALID: entry('源码快照标识不正确，请联系管理员检查同步结果。', 'admin'),
  SOURCE_RELEASE_INVALID: entry('源码快照版本标识不正确，请联系管理员检查同步结果。', 'admin'),
  SOURCE_SYNC_FAILED: entry('源码同步失败，请稍后重新同步；持续失败时联系管理员并提供技术标识。', 'retry'),
  SOURCE_READ_FAILED: entry('源码读取失败，请稍后重试；持续失败时联系管理员并提供技术标识。', 'retry'),
  SOURCE_UNAVAILABLE: entry('源码服务暂时不可用，请稍后重试；持续失败时联系管理员并提供技术标识。', 'retry'),
  SOURCE_NETWORK_ERROR: entry('无法连接源码服务，请检查网络后重试。', 'retry'),
  SOURCE_RESPONSE_INVALID: entry('源码服务返回了无法识别的响应，请稍后重试；持续失败时联系管理员。', 'retry'),
  SOURCE_SESSION_REQUIRED: entry('登录状态已失效，请重新登录后操作源码。', 'none'),
};

export function sourceError(value: unknown, provider?: string): SourceError {
  const raw = value instanceof Error ? value.message : value;
  const code = typeof raw === 'string' && Object.hasOwn(sourceErrors, raw) ? raw : 'SOURCE_UNAVAILABLE';
  return { code, ...sourceErrors[code], message: sourceErrors[code].message.replaceAll('{platform}', provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : '代码托管平台') };
}

export async function readSourceResponse(response: Response) {
  let body: any;
  try { body = JSON.parse(await response.text()); }
  catch (error) { throw new Error(error instanceof TypeError ? 'SOURCE_NETWORK_ERROR' : 'SOURCE_RESPONSE_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('SOURCE_RESPONSE_INVALID');
  if (!response.ok) {
    const code = typeof body.error === 'string' && Object.hasOwn(sourceErrors, body.error) ? body.error
      : response.status === 401 ? 'SOURCE_SESSION_REQUIRED' : response.status === 403 ? 'SOURCE_READ_FORBIDDEN'
      : response.status === 429 ? 'SOURCE_RATE_LIMITED' : 'SOURCE_UNAVAILABLE';
    throw new Error(code);
  }
  return body;
}

export function renderSourceError(error: SourceError | null) {
  return error ? html`<app-notice role="alert" severity="error">${error.message}</app-notice><details><summary>技术详情</summary><p><code>${error.code}</code>${error.detail ? html` · ${error.detail}` : nothing}</p></details>` : nothing;
}
