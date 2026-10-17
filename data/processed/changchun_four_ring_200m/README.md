# 长春四环 200 米 GIS 基础数据

Rin（GitHub: Cola2233）提供。处理日期2026-10-17。范围为作者数据 `T4_huan`，面积约299.39km²。

## 文件

| 文件 | 内容 |
|---|---|
| vectors/study_area.geojson | 四环精确裁剪面，WGS84经纬度 |
| vectors/expressways.geojson | OSM快速路口径，824个要素，含连接匝道 |
| vectors/arterials.geojson | OSM主干路口径，796个要素，含连接匝道 |
| rasters/WorldCover_2021_200m.tif | ESA2021 v200优势地类；众数聚合，NoData=0 |
| rasters/DEM_Copernicus_DSM_200m.tif | Copernicus GLO-30 DSM；平均聚合，米，NoData=-9999 |
| rasters/LST_2023_200m.tif | 本地2023 LST第1波段；平均聚合，摄氏度，NoData=-9999 |
| verification.json | 网格、掩膜、覆盖与道路边界核验结果 |
| sources.json | 来源、年份、聚合规则和署名 |
| checksums.sha256 | 此目录除本文件外的所有文件的传输校验值 |

三张栅格统一EPSG:32651（WGS84/UTM51N）、200×200米，103列×99行；左上角(674600,4872000)，外包范围(674600,4852200,695200,4872000)。边界外按像元中心设NoData，四环内7486个像元三图均有有效值。GeoJSON遵循RFC7946，坐标顺序为经度、纬度。

## 接入现有程序

仓库已有 `scripts/build_changchun_grid.py`，本目录保留其要求的rasters/vectors文件名。可从仓库根目录运行：

```sh
python -m pip install -r scripts/requirements-changchun-data.txt
python scripts/validate_changchun_handoff.py
python -X utf8 scripts/build_changchun_grid.py data/processed/changchun_four_ring_200m app/data/changchun.js
```

构建命令的`-X utf8`用于兼容Windows默认中文编码，保证UTF-8 GeoJSON能正常读取。

构建脚本会排除 `is_link=true` 的匝道；原GeoJSON仍完整保留连接线及OSM属性。道路分类为OSM标签映射，未由官方道路等级表核定；trunk可能包含干线。不能直接解释为法定道路等级。双向分幅与连接线保留，length_m不是去重的道路中心线里程。

## 地理含义

- WorldCover众数代表优势地类，不代表混合地类比例。代码10树木、20灌木、30草地、40耕地、50建成、60裸地、70冰雪、80水体、90湿地、95红树林、100苔藓地衣。
- 高程实际为DSM，包含建筑/树冠，不能当裸地DTM用于精细内涝模拟；本次未转换垂直基准。
- LST年份来自源文件名，采集日期、季节合成与原始QA待追溯。所有有限温度均保留，未删除大于50°C像元。用于教学参考，不能宣称重现论文原始月份。
- WorldCover2021、LST2023、OSM2026下载快照时相不同。来源与数据权利见sources.json；本次未为作者提供的边界/LST另行赋予开放许可。
- 此目录是处理后的交接成果。原始大影像、个人路径和聊天记录未纳入提交。原始作者资料继续按现有data/raw/约定在本地保存。

署名：© OpenStreetMap contributors（ODbL）；© ESA WorldCover project2021 / Contains modified Copernicus Sentinel data2021（CC-BY4.0）；Copernicus DEM。各源数据许可独立，勿为整个目录统一套用新的数据许可。
