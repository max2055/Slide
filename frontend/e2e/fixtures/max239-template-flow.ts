import "../../src/app/styles/tokens.css";
import "../../src/app/ui/components/app-toast-container.js";
import "../../src/app/ui/components/native-template-configuration.js";
import "../../src/app/ui/views/event-management.js";
document.body.style.cssText =
  "margin:24px;background:var(--bg);color:var(--text);font-family:system-ui";
const note = document.createElement("p");
note.textContent =
  "隔离验收：正常试采读取本 run 只读 MySQL；95/85/60 为受控采集输入，经注册指标与正式 writer。未运行外部通知或 AI。";
document.body.append(note, document.createElement("app-toast-container"));
const cfg = document.createElement("native-template-configuration") as any;
cfg.resourceType = "instance";
cfg.resourceId = 1;
document.body.append(cfg);
const heading = document.createElement("h2");
heading.textContent = "现有事件中心";
document.body.append(heading, document.createElement("event-management-page"));
