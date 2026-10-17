# Rin：长春四环200米数据交接

入口：[data/processed/changchun_four_ring_200m](../data/processed/changchun_four_ring_200m/README.md)。

本次补齐现有app/data/changchun.js所依赖的GIS交接输入：道路GeoJSON、研究区面及三张对齐GeoTIFF。数据来自此前已经核验的四环交接包。原始资料仍留在本地data/raw/；本次只增加处理成果、来源记录与验证工具。

现有scripts/build_changchun_grid.py可以直接读取本目录。此次不修改BRIEF、前端生成数据或模拟机制。开发同伴接手时，先运行核验脚本，再按数据README中的命令自行重建前端输入。

重点口径：T4_huan约299.39km²；EPSG32651；200米；103×99；连接匝道保留在GeoJSON但由现有前端构建脚本排除。DSM并非裸地DTM；LST采集日期和QA仍需追溯；OSM分类并非法定道路等级。
