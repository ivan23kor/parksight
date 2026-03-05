#!/usr/bin/env python3
"""Parse YOLO training logs and extract metrics."""

import re
import json
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Dict, Tuple

@dataclass
class EpochMetrics:
    epoch: int
    box_loss: float
    cls_loss: float
    dfl_loss: float
    precision: float = 0.0
    recall: float = 0.0
    mAP50: float = 0.0
    mAP50_95: float = 0.0

def parse_log(log_path: str) -> Tuple[Dict[int, EpochMetrics], dict]:
    """Parse Ultralytics YOLO training log."""
    epochs = {}
    log_info = {}
    epoch_numbers = []  # Track when each epoch starts

    with open(log_path, 'r') as f:
        content = f.read()

    # Extract experiment info
    if 'Experiment C:' in content:
        log_info['experiment'] = 'C: Controlled Negatives + Augmentation ON'
    elif 'Experiment D:' in content:
        log_info['experiment'] = 'D: YOLO11l (Large Model)'
    elif 'Experiment E:' in content:
        log_info['experiment'] = 'E: High Resolution'
    elif 'Experiment B:' in content:
        log_info['experiment'] = 'B: Full Augmentation'
    elif 'Experiment A:' in content:
        log_info['experiment'] = 'A: Baseline'

    m = re.search(r'yolo(\w+)\.pt', content)
    if m:
        log_info['model'] = f"YOLO{m.group(1).upper()}"

    # Get max epochs
    m = re.search(r'Max epochs: (\d+)', content)
    if m:
        max_epochs = int(m.group(1))
        log_info['max_epochs'] = max_epochs
    else:
        max_epochs = 80  # default

    lines = content.split('\n')

    # First pass: find epoch boundaries by tracking when new epochs start
    current_epoch = 0
    for i, line in enumerate(lines):
        # Match "  1/80  4.58G  ..." - first occurrence of each epoch
        m = re.search(r'(\d+)/(\d+)\s+[\d.]+G\s+[\d.]+\s+[\d.]+\s+[\d.]+', line)
        if m:
            epoch = int(m.group(1))
            total = int(m.group(2))
            if total == max_epochs and epoch > current_epoch:
                epoch_numbers.append((epoch, i))
                current_epoch = epoch

    # Second pass: extract validation results
    # Format: "201.5s	171	                   all        321        598       0.53      0.396      0.397      0.192"
    # Where: 'all' at position 2, 321=images, 598=instances, 0.53=P, 0.396=R, 0.397=mAP50, 0.192=mAP50-95
    for i, line in enumerate(lines):
        parts = line.split()
        if len(parts) >= 9 and 'all' in parts:
            # Find the position of 'all' in the parts
            try:
                all_idx = parts.index('all')
                if all_idx >= 2 and len(parts) >= all_idx + 5:
                    precision = float(parts[all_idx + 2])
                    recall = float(parts[all_idx + 3])
                    mAP50 = float(parts[all_idx + 4])
                    mAP50_95 = float(parts[all_idx + 5])

                    # Find which epoch this belongs to
                    epoch_num = None
                    for j, (ep, line_num) in enumerate(epoch_numbers):
                        if i > line_num:
                            epoch_num = ep
                        else:
                            break

                    if epoch_num is not None and epoch_num not in epochs:
                        epochs[epoch_num] = EpochMetrics(
                            epoch_num, 0, 0, 0, precision, recall, mAP50, mAP50_95
                        )
            except (ValueError, IndexError):
                pass

    # Third pass: get loss values for each epoch
    for line in lines:
        # Match training progress: "   1/80  4.58G  1.435  3.654  1.365  ..."
        m = re.search(r'(\d+)/(\d+)\s+[\d.]+G\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)', line)
        if m:
            epoch = int(m.group(1))
            total = int(m.group(2))
            if total == max_epochs and epoch in epochs:
                # Update losses (last occurrence wins)
                epochs[epoch].box_loss = float(m.group(3))
                epochs[epoch].cls_loss = float(m.group(4))
                epochs[epoch].dfl_loss = float(m.group(5))

    return epochs, log_info

def main():
    log_dir = Path('/home/ivan23kor/Code/parksight/logs')

    all_data = {}
    for log_file in sorted(log_dir.glob('*.txt')):
        if log_file.name == 'parsed_metrics.json':
            continue
        print(f"Processing {log_file.name}...")
        try:
            metrics, info = parse_log(str(log_file))
            sorted_metrics = [metrics[e] for e in sorted(metrics.keys())]
            all_data[log_file.stem] = {'metrics': sorted_metrics, 'info': info}
            print(f"  Found {len(sorted_metrics)} epochs")
            if sorted_metrics:
                print(f"  Epochs: {sorted_metrics[0].epoch} to {sorted_metrics[-1].epoch}")
                if sorted_metrics[-1].mAP50 > 0:
                    print(f"  Final mAP50: {sorted_metrics[-1].mAP50:.4f}, mAP50-95: {sorted_metrics[-1].mAP50_95:.4f}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"  Error: {e}")

    # Save to JSON
    output = {}
    for key, data in all_data.items():
        output[key] = {
            'info': data['info'],
            'metrics': [asdict(m) for m in data['metrics']]
        }

    out_path = log_dir / 'parsed_metrics.json'
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved to {out_path}")

if __name__ == '__main__':
    main()
