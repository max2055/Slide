import "../../src/app/styles/tokens.css";
import "../../src/app/ui/components/app-toast-container.js";
import "../../src/app/ui/views/event-management.js";
import "../../src/app/ui/views/event-center.js";

document.body.style.cssText =
  "margin:24px;background:var(--bg);color:var(--text);font-family:system-ui";
const note = document.createElement("p");
note.textContent =
  "隔离验收：实际只读 collector → 正常正式 writer → 既有事件与历史。运行时长自然越过固定阈值；未修改目标负载或配置，未外发通知。";
document.body.append(
  note,
  document.createElement("app-toast-container"),
  document.createElement("event-center-page"),
);
