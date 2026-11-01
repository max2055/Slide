import "../../src/app/styles/tokens.css";
import "../../src/app/ui/components/app-toast-container.js";
import "../../src/app/ui/views/event-management.js";
import "../../src/app/ui/views/event-center.js";

document.body.style.cssText =
  "margin:24px;background:var(--bg);color:var(--text);font-family:system-ui";
const note = document.createElement("p");
note.textContent =
  "隔离验收：受控 SNMP UDP 端点 → 正常正式 writer → 既有事件与历史。95/85/60 是协议端点受控值，不是硬件实测；通知按成员决定豁免。";
document.body.append(
  note,
  document.createElement("app-toast-container"),
  document.createElement("event-center-page"),
);
