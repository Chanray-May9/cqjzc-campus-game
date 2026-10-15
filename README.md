# 重庆建筑工程职业学院 · 东站校区 — 自由漫游

一个 GTA5 自由模式风格的校园开放世界。地图由 Blender 程序化建模（含程序生成的
材质贴图），导出 GLB，在浏览器里用 three.js 做第三人称漫游、开车、跑跳。

**双击 `启动游戏.bat` 即可玩。**

---

## 一、操作

| 按键 | 作用 |
|---|---|
| `W A S D` / 方向键 | 移动 / 驾驶 |
| `Shift` | 奔跑 / 加速 |
| `Space` | 跳跃 / 手刹（车内） |
| `F` | 上车 / 下车（靠近车辆时） |
| `C` | 切换视角（第三人称 / 越肩 / 第一人称） |
| 鼠标 | 环视；滚轮缩放 |
| `N` | 昼夜切换（时间也会自动流逝，约 15 分钟一天） |
| `H` | 收起 / 展开帮助面板 |
| `Esc` | 释放鼠标 |

界面：左下角圆形雷达小地图（随朝向旋转）、右下角速度表、左上角当前位置名、
右上角时间与昼夜状态。

---

## 二、目录结构

```
cqjzc-campus-game/
├── 启动游戏.bat              一键启动（自动选 Node 或 Python 起本地服务器并打开浏览器）
├── README.md
├── blender/
│   ├── texgen.py             程序化材质贴图生成（23 张，numpy → Blender 图像，打包进 GLB）
│   ├── layout.py             校园总平面数据（建筑清单 / 道路 / 台地 / 车辆点位）
│   ├── build_campus.py       主构建脚本：地形、道路、建筑、树木、路灯、围墙、导出
│   ├── texpreview.py         材质联系表预览
│   └── render_preview.py     多机位渲染预览（plan/top/front/saucer/axis/gym）
├── tools/
│   ├── serve.js              本地静态服务器
│   ├── verify.js             GLB 结构 + 出生点/车辆/POI 空间校验 + 面积对账
│   └── crop_ref.py           参考图裁切放大工具
└── web/
    ├── index.html            页面外壳 + HUD
    ├── js/game.js            游戏主体（第三人称控制、载具、碰撞、小地图、昼夜）
    ├── vendor/               three.js r147 + GLTFLoader（本地自带，无需联网）
    └── assets/
        ├── campus.glb        校园模型（35.84 MB，含贴图）
        └── campus_meta.json  碰撞体、POI、车辆、道路、出生点
```

---

## 三、怎么重建地图

```powershell
# 1) 生成模型（约 2~4 分钟）
D:\blender\blender.exe --background --factory-startup --python blender\build_campus.py

# 2) 校验（必须 0 错误 0 警告）
node tools\verify.js

# 3) 出图预览
D:\blender\blender.exe -b --factory-startup -P blender\render_preview.py -- plan "D:\deepseek harness workspace\cqjzc-campus-game\reference\plan.png" 0.85
D:\blender\blender.exe -b --factory-startup -P blender\render_preview.py -- front "D:\deepseek harness workspace\cqjzc-campus-game\reference\front.png" 1.0
```

改校园布局只需改 `blender/layout.py` 里的 `BLD` / `ROADS` / `TERRACE_*`，
`build_campus.py` 开头的 `build_overlap_report()` 会自动检查建筑重叠、越界、
压在台地放坡上、道路穿楼等问题并在控制台报警。

---



## 四、技术说明

- **材质**：23 张 256² 程序生成贴图（混凝土、横条窗幕墙、红色色块、红格栅、
  玻璃、沥青、红色塑胶跑道、草坪、足球场、屋顶绿化、铺装、砖、树皮、树叶、
  金属、直立锁边屋面、夜景发光窗…），全部用 numpy 生成后打包进 GLB。
- **夜景**：横条窗幕墙带一张**随机点亮的窗格自发光贴图**，JS 在夜间把
  `emissiveIntensity` 拉起来，白天归零。
- **碰撞**：27 个分块旋转包围盒（由 Blender 脚本一并导出）+ 解析地形高程函数
  （由同一次构建导出平台/阶梯配置，terrain.js 共用求值；校验含 Python 采样对比），无需 heightmap 数据。
- **性能**：约 119 万顶点 / 58 万三角面，按材质合并网格；树木合并进
  两个材质网格；阴影仅一盏方向光跟随玩家。
- **为什么必须用本地服务器**：浏览器不允许 `file://` 页面读取 `assets/campus.glb`。
  `启动游戏.bat` 会起一个本地静态服务器（默认端口 8123）。直接双击
  `web/index.html` 会看到明确的错误提示。

---

## 五、校验

```powershell
node tools\verify.js
```

会做这些检查（当前结果：**0 错误 0 警告**）：

- GLB 容器魔数 / 版本 / 声明长度 / 分块解析
- mesh / material / accessor / image 数量，总顶点数与三角面数，整体包围盒
- 每个材质是否带 baseColorTexture
- 出生点是否在地面上且不在任何碰撞体内
- 18 辆车是否贴地且不与建筑重叠
- 32 个 POI 是否都在用地范围内
- 建筑面积合计 vs 官方 169,594.17 ㎡ 对账
- 建筑条目数 vs 官方 23 条 / 19 栋
