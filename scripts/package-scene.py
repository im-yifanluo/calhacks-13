#!/usr/bin/env python3
"""Package one reconstructed scene folder for the memos browser importer. No upload."""
import argparse
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('folder', type=Path)
parser.add_argument('output', type=Path, help='output filename ending in .memos.zip')
args = parser.parse_args()
root = args.folder.resolve(strict=True)
if not (root / 'memory.json').is_file():
    parser.error('The scene folder must contain memory.json')
if not str(args.output).endswith('.memos.zip'):
    parser.error('Output must end in .memos.zip')
allowed = {'.json', '.spz', '.ply', '.splat', '.ksplat', '.sog', '.glb', '.bin', '.m4a', '.mp4', '.mov'}
files = sorted(p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in allowed and not any(part.startswith('.') for part in p.relative_to(root).parts))
if any(p.is_symlink() or not p.resolve().is_relative_to(root) for p in files):
    parser.error('Scene contains links outside its folder')
if len(files) > 4000 or sum(p.stat().st_size for p in files) > 250 * 1024 * 1024:
    parser.error('Scene exceeds the 250 MB / 4,000 file browser limit')
args.output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(args.output, 'x', compression=ZIP_DEFLATED, compresslevel=1) as bundle:
    for file in files:
        bundle.write(file, file.relative_to(root).as_posix())
print(f'{args.output}: {len(files)} files, {args.output.stat().st_size / 1048576:.1f} MB. Importer validates the chosen manifest before opening.')
