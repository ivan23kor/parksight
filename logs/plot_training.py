#!/usr/bin/env python3
"""Plot YOLO training metrics from parsed logs."""

import json
import matplotlib.pyplot as plt
import matplotlib
matplotlib.use('Agg')
from pathlib import Path

def plot_metrics(data_path: str, output_dir: str = None):
    """Plot training metrics from parsed JSON data."""
    with open(data_path, 'r') as f:
        data = json.load(f)

    if output_dir is None:
        output_dir = str(Path(data_path).parent)

    # Color scheme
    colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b']

    for log_id, log_data in data.items():
        metrics = log_data['metrics']
        info = log_data.get('info', {})
        experiment = info.get('experiment', log_id)
        model = info.get('model', '')

        if not metrics:
            print(f"Skipping {log_id} - no metrics")
            continue

        epochs = [m['epoch'] for m in metrics]
        box_loss = [m['box_loss'] for m in metrics]
        cls_loss = [m['cls_loss'] for m in metrics]
        dfl_loss = [m['dfl_loss'] for m in metrics]
        precision = [m['precision'] for m in metrics]
        recall = [m['recall'] for m in metrics]
        mAP50 = [m['mAP50'] for m in metrics]
        mAP50_95 = [m['mAP50_95'] for m in metrics]

        # Skip if all mAP values are 0 (no validation data)
        if max(mAP50) == 0:
            print(f"Skipping {log_id} - no validation data")
            continue

        # Create figure with subplots
        fig, axes = plt.subplots(2, 2, figsize=(14, 10))
        fig.suptitle(f'{experiment} - {model}', fontsize=14, fontweight='bold')

        # 1. Training Loss
        ax = axes[0, 0]
        ax.plot(epochs, box_loss, label='Box Loss', color=colors[0], linewidth=2)
        ax.plot(epochs, cls_loss, label='Cls Loss', color=colors[1], linewidth=2)
        ax.plot(epochs, dfl_loss, label='DFL Loss', color=colors[2], linewidth=2)
        ax.set_xlabel('Epoch')
        ax.set_ylabel('Loss')
        ax.set_title('Training Loss')
        ax.legend()
        ax.grid(True, alpha=0.3)

        # 2. mAP scores
        ax = axes[0, 1]
        ax.plot(epochs, mAP50, label='mAP@50', color=colors[3], linewidth=2)
        ax.plot(epochs, mAP50_95, label='mAP@50-95', color=colors[4], linewidth=2)
        ax.set_xlabel('Epoch')
        ax.set_ylabel('Score')
        ax.set_title('Mean Average Precision')
        ax.legend()
        ax.grid(True, alpha=0.3)
        ax.set_ylim([0, 1])

        # 3. Precision and Recall
        ax = axes[1, 0]
        ax.plot(epochs, precision, label='Precision', color=colors[3], linewidth=2, linestyle='--')
        ax.plot(epochs, recall, label='Recall', color=colors[4], linewidth=2, linestyle='--')
        ax.set_xlabel('Epoch')
        ax.set_ylabel('Score')
        ax.set_title('Precision & Recall')
        ax.legend()
        ax.grid(True, alpha=0.3)
        ax.set_ylim([0, 1])

        # 4. Combined metrics summary
        ax = axes[1, 1]
        ax.plot(epochs, mAP50, label='mAP@50', color=colors[3], linewidth=2)
        ax.plot(epochs, precision, label='Precision', color=colors[3], linewidth=1.5, linestyle='--', alpha=0.7)
        ax.plot(epochs, recall, label='Recall', color=colors[4], linewidth=1.5, linestyle='--', alpha=0.7)
        ax.set_xlabel('Epoch')
        ax.set_ylabel('Score')
        ax.set_title('All Metrics')
        ax.legend()
        ax.grid(True, alpha=0.3)
        ax.set_ylim([0, 1])

        plt.tight_layout()

        output_path = f'{output_dir}/{log_id}_training_curves.png'
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()
        print(f"Saved: {output_path}")

        # Print summary statistics
        print(f"\n{log_id} ({experiment}):")
        print(f"  Epochs: {epochs[0]} to {epochs[-1]}")
        print(f"  Best mAP@50: {max(mAP50):.4f} (epoch {epochs[mAP50.index(max(mAP50))]})")
        print(f"  Best mAP@50-95: {max(mAP50_95):.4f} (epoch {epochs[mAP50_95.index(max(mAP50_95))]})")
        print(f"  Final mAP@50: {mAP50[-1]:.4f}")
        print(f"  Final mAP@50-95: {mAP50_95[-1]:.4f}")

def plot_comparison(data_path: str, output_dir: str = None):
    """Plot comparison of mAP across experiments."""
    with open(data_path, 'r') as f:
        data = json.load(f)

    if output_dir is None:
        output_dir = str(Path(data_path).parent)

    colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd']

    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Plot mAP@50 comparison
    ax = axes[0]
    for i, (log_id, log_data) in enumerate(data.items()):
        metrics = log_data['metrics']
        info = log_data.get('info', {})
        label = info.get('experiment', log_id)

        if not metrics:
            continue

        epochs = [m['epoch'] for m in metrics]
        mAP50 = [m['mAP50'] for m in metrics]

        if max(mAP50) > 0:
            ax.plot(epochs, mAP50, label=label, color=colors[i % len(colors)], linewidth=2)

    ax.set_xlabel('Epoch')
    ax.set_ylabel('mAP@50')
    ax.set_title('mAP@50 Comparison')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.set_ylim([0, 1])

    # Plot mAP@50-95 comparison
    ax = axes[1]
    for i, (log_id, log_data) in enumerate(data.items()):
        metrics = log_data['metrics']
        info = log_data.get('info', {})
        label = info.get('experiment', log_id)

        if not metrics:
            continue

        epochs = [m['epoch'] for m in metrics]
        mAP50_95 = [m['mAP50_95'] for m in metrics]

        if max(mAP50_95) > 0:
            ax.plot(epochs, mAP50_95, label=label, color=colors[i % len(colors)], linewidth=2)

    ax.set_xlabel('Epoch')
    ax.set_ylabel('mAP@50-95')
    ax.set_title('mAP@50-95 Comparison')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.set_ylim([0, 1])

    plt.tight_layout()

    output_path = f'{output_dir}/experiment_comparison.png'
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f"\nSaved comparison: {output_path}")

def main():
    data_path = '/home/ivan23kor/Code/parksight/logs/parsed_metrics.json'
    output_dir = '/home/ivan23kor/Code/parksight/logs'

    print("Generating individual experiment plots...")
    plot_metrics(data_path, output_dir)

    print("\nGenerating comparison plot...")
    plot_comparison(data_path, output_dir)

if __name__ == '__main__':
    main()
