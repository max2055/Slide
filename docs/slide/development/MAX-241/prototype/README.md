# MAX-241 三类完整资源详情原型

演示数据、纯前端、无构建步骤、不连后端。用于评审[详情设计](../03-detail-design.md)与六种状态；不能作为生产验收依据。

## 运行

```bash
cd docs/slide/development/MAX-241/prototype
python3 -m http.server 8971 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8971/index.html
```

必须通过 HTTP 打开（ES module 不支持 `file://`）。

## URL 参数（便于逐状态评审与截图）

| 参数 | 取值 | 说明 |
|---|---|---|
| `class` | `db` / `server` / `network` | 资源类型 |
| `view` | `list` / `detail` | 列表或完整详情 |
| `tab` | 页签 key，如 `overview` / `collection` / `metrics` / `diagnostics` / `backups` | 详情页签 |
| `state` | `normal` / `empty` / `loading` / `error` / `partial` / `forbidden` | 页面或列表状态 |
| `long` | `1` | 长名称演示 |
| `full` | `1` | 评审截图用：整页滚动（正常评审不需要） |

示例：
`index.html?class=db&view=detail&tab=collection&state=partial`

顶部“设计评审控制条”可交互切换以上参数；它不属于产品界面。

## 交互与键盘

- 页签：`←`/`→`/`Home`/`End` 切换，焦点跟随，`aria-selected` 同步。
- 弹窗：打开聚焦、`Esc` 关闭、关闭后焦点回到触发按钮。
- 表格：容器可聚焦后方向键横向滚动；聚焦截断内容可看全文。
- 行内四操作均为演示：编辑/测试/删除打开示意弹窗，不产生写操作。

## 文件

| 文件 | 内容 |
|---|---|
| `index.html` | 外壳、评审控制条、弹窗挂载点 |
| `styles.css` | 复用的 design token 子集、按钮契约、卡片/徽章/空状态/表格 |
| `app.js` | 三类演示数据、列表与详情渲染、状态、键盘与弹窗 |

验证脚本与截图说明见 [../05-validation.md](../05-validation.md)。
