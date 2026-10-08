# dsh-deepseek-billing-period

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）Web 插件：在输入框下方常驻显示**当前 DeepSeek API 计费时段** —— 是高峰（全价）还是空闲（半价），以及距离下一次时段切换的倒计时。

- 药丸实时刷新，倒计时精确到分，每秒更新。
- 点击药丸会在其**正上方弹出浮动的规则说明卡片**，不占用输入框布局（展开前后输入区尺寸逐像素不变）；点击卡片外部任意位置或按 `Esc` 关闭。
- 卡片表面与宿主自带的 composer 浮层（如"上下文已用 …%"）保持同一套观感：半透明底、发丝描边、柔和投影、`--dsw-radius-lg` 圆角。
- 判定恒按**北京时间（UTC+8）** 换算，与浏览器所在时区无关；中英文案随界面语言切换，节假日名称也会本地化。

## 计费规则

| 时段 | 判定 | 价格 |
| --- | --- | --- |
| 高峰 | 北京时间周一至周五 `09:00–12:00`、`14:00–18:00`，且当天不是中国法定节假日 | 全价 |
| 空闲 | 其余全部时间，包含周末与法定节假日全天 | 高峰价格的一半 |

- 两个窗口均为**左闭右开**：`09:00` 起进入高峰，`12:00` / `18:00` 起离开高峰；午休 `12:00–14:00` 属空闲。
- 内置国务院办公厅年度放假安排：2025 年（国办发明电〔2024〕12 号）、2026 年（国办发明电〔2025〕7 号）。
- 只需收录落在工作日的节假日：周末本身全天空闲，因此调休上班的周末不影响判定。
- 未收录年份（例如尚未公布放假安排的 2027 年）自动回退为"仅按周一至周五判断"，并在展开卡片中明确写出该提示，不会静默给出错误的"高峰"结论。

## 安装方法

前置：已安装 `dsh` 并启用 web profile（本插件在 `dsh 0.2.0-rc.2` / Node v26 上验证）。

### 方式一：从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:zi7tian/dsh-deepseek-billing-period
```

`dsh plugin add` 会在该 profile 内执行安装，并把声明了 bundle 的包追加到 `dsh.profile.bundles`。完成后重启 `dsh web`，刷新页面即可在输入框下方看到计费时段药丸。

### 方式二：本地克隆后 link（便于改代码）

```sh
git clone https://github.com/zi7tian/dsh-deepseek-billing-period.git
dsh plugin --profile web add link:/path/to/dsh-deepseek-billing-period
```

用 `link:` 安装时，直接编辑 checkout 里的 `client.js` 并在浏览器刷新页面即可生效，无需重装或重启 `dsh web`。

### 卸载

```sh
dsh plugin --profile web remove dsh-deepseek-billing-period
```

### 安装成功的标志

新开或打开任意一个**已有会话**（空白首页没有输入框，按宿主设计不会渲染该 slot），输入框下方会出现：

```
● 空闲时段 · 半价 · 距高峰 12 小时 42 分
```

点击它即可展开上方那张规则说明卡片。
