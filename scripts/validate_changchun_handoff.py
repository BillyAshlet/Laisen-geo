"""Validate the committed Changchun GIS handoff without modifying any files."""
from pathlib import Path
from collections import Counter
import argparse
import hashlib
import json

import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.warp import transform as transform_xy
from shapely.geometry import shape
from shapely.ops import transform
from shapely.prepared import prep


DEFAULT_DATA = Path(__file__).resolve().parents[1] / 'data/processed/changchun_four_ring_200m'
CRS = 'EPSG:32651'


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def projected(geometry):
    return transform(lambda x, y, z=None: transform_xy('EPSG:4326', CRS, x, y), geometry)


def validate(data_dir):
    checksums = (data_dir / 'checksums.sha256').read_text(encoding='utf-8').splitlines()
    listed = set()
    for row in checksums:
        expected, relative = row.split('  ', 1)
        path = (data_dir / relative).resolve()
        require(path.is_relative_to(data_dir.resolve()), 'Checksum path escapes data directory')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f'Checksum mismatch: {relative}')
        listed.add(relative)
    actual = {p.relative_to(data_dir).as_posix() for p in data_dir.rglob('*') if p.is_file() and p.name != 'checksums.sha256'}
    require(listed == actual, 'Checksum file does not describe the full data directory')
    boundary = projected(shape(load(data_dir / 'vectors/study_area.geojson')['features'][0]['geometry']))
    require(boundary.is_valid and abs(boundary.area / 1e6 - 299.3858726984876) < 1e-6, 'Unexpected study boundary')
    tolerance = boundary.buffer(.002)
    prepared = prep(tolerance)
    raster_stats = []
    reference = None
    for filename, dtype, nodata in [
        ('WorldCover_2021_200m.tif', 'uint8', 0),
        ('DEM_Copernicus_DSM_200m.tif', 'float32', -9999),
        ('LST_2023_200m.tif', 'float32', -9999),
    ]:
        with rasterio.open(data_dir / 'rasters' / filename) as ds:
            signature = (ds.crs, ds.shape, ds.transform)
            reference = reference or signature
            require(signature == reference, 'Rasters do not share a grid')
            require(str(ds.crs) == CRS and ds.shape == (99, 103) and ds.res == (200, 200), 'Unexpected raster grid')
            require(tuple(ds.transform)[:6] == (200, 0, 674600, 0, -200, 4872000), 'Unexpected grid origin')
            require(ds.count == 1 and ds.dtypes == (dtype,) and ds.nodata == nodata, 'Unexpected raster encoding')
            require('source_path' not in ds.tags(), 'Local source path remains in raster tags')
            mask = geometry_mask([boundary.__geo_interface__], ds.shape, ds.transform, invert=True)
            values = ds.read(1, masked=True)
            require(values[~mask].count() == 0 and values.count() == 7486, 'Unexpected raster mask or coverage')
            require(np.isfinite(values.compressed()).all(), 'Nonfinite raster values')
            if dtype == 'uint8':
                require(set(np.unique(values.compressed()).tolist()) <= {10,20,30,40,50,60,70,80,90,95,100}, 'Invalid WorldCover class')
            raster_stats.append({'file': filename, 'valid_cells': int(values.count()), 'min': float(values.min()), 'max': float(values.max())})
    road_stats = []
    for name, allowed, expected in [
        ('expressways', {'motorway','motorway_link','trunk','trunk_link'}, 824),
        ('arterials', {'primary','primary_link'}, 796),
    ]:
        fc = load(data_dir / 'vectors' / (name + '.geojson'))
        require('crs' not in fc and len(fc['features']) == expected, 'Unexpected GeoJSON encoding or count')
        counts = Counter()
        for feature in fc['features']:
            properties = feature['properties']
            require(properties['highway'] in allowed, 'Unexpected road class')
            require(properties['is_link'] == properties['highway'].endswith('_link'), 'Incorrect link flag')
            geometry = projected(shape(feature['geometry']))
            require(geometry.geom_type in {'LineString','MultiLineString'} and geometry.is_valid and geometry.length > 0, 'Invalid road geometry')
            require(prepared.covers(geometry) or geometry.difference(tolerance).length < .002, 'Road crosses study boundary')
            require(abs(geometry.length - properties['length_m']) < .01, 'Incorrect road length')
            counts[properties['highway']] += 1
        road_stats.append({'file': name + '.geojson', 'feature_count': expected, 'highway_counts': dict(counts)})
    saved = load(data_dir / 'verification.json')
    require(saved['status'] == 'passed', 'Saved report is not passed')
    for stats in raster_stats:
        reported = next(row for row in saved['raster_checks'] if row['file'] == stats['file'])
        require(reported['valid_cells'] == stats['valid_cells'] and abs(reported['min'] - stats['min']) < 1e-6 and abs(reported['max'] - stats['max']) < 1e-6, 'Saved raster report disagrees with data')
    require({row['file']: row['feature_count'] for row in saved['road_checks']} == {row['file']: row['feature_count'] for row in road_stats}, 'Saved road report disagrees with data')
    return {'status': 'passed', 'checksummed_files': len(checksums), 'rasters': raster_stats, 'roads': road_stats}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    print(json.dumps(validate(args.data_dir.resolve()), indent=2))
