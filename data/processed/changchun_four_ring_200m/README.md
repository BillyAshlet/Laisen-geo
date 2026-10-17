# 长春四环基础数据

范围采用 `T4_huan`，面积约 299.39 km²。三张栅格统一为 EPSG:32651、200 米、103×99；GeoJSON 使用 WGS84 经纬度。

| 文件 | 内容 |
|---|---|
| vectors/study_area.geojson | 四环边界 |
| vectors/expressways.geojson | 快速路，824 个要素 |
| vectors/arterials.geojson | 主干路，796 个要素 |
| rasters/WorldCover_2021_200m.tif | 2021 年土地覆盖，众数聚合，NoData=0 |
| rasters/DEM_Copernicus_DSM_200m.tif | Copernicus 高程，平均聚合，单位米，NoData=-9999 |
| rasters/LST_2023_200m.tif | 2023 年地表温度，平均聚合，单位 °C，NoData=-9999 |

道路按 OSM 标签分类，保留了 `is_link` 匝道标记和 `length_m` 长度字段。现有构建脚本会跳过匝道。

在项目根目录运行：

```sh
python -m pip install -r scripts/requirements-changchun-data.txt
python scripts/validate_changchun_data.py
python -X utf8 scripts/build_changchun_grid.py data/processed/changchun_four_ring_200m app/data/changchun.js
```

`-X utf8` 用于 Windows 下读取中文道路属性。数据来源见 `sources.json`，检查结果见 `verification.json`，文件校验值见 `checksums.sha256`。

高程为 DSM，包含建筑和树冠；LST 年份取自源文件名，采集日期和原始质量信息尚未补齐。土地覆盖、LST 和道路的年份不同。

来源署名：© OpenStreetMap contributors（ODbL）；© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data 2021（CC-BY 4.0）；Copernicus DEM。各源数据保留原有权利。
