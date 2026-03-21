# Moments Content Clustering

Clusters WeChat moments by vector similarity using K-Means, then uses LLM to label each cluster.

## Setup

```bash
cd scripts/clustering
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

```bash
# Run from project root, with venv activated
python scripts/clustering/moments_cluster.py

# Custom number of clusters
python scripts/clustering/moments_cluster.py --k 15

# Auto-detect optimal k (elbow method, range 5-25)
python scripts/clustering/moments_cluster.py --auto-k

# Use cloud LLM for cluster labeling
python scripts/clustering/moments_cluster.py --provider deepseek
python scripts/clustering/moments_cluster.py --provider doubao

# Dry run (don't write to SQLite)
python scripts/clustering/moments_cluster.py --dry-run

# Limit points for testing
python scripts/clustering/moments_cluster.py --limit 200
```

## What it does

1. Scrolls all points from `wechat_moments` Qdrant collection **with vectors**
2. Runs K-Means clustering on the vectors
3. For each cluster, picks 5 representative samples (closest to centroid)
4. Calls LLM to generate a short label for each cluster
5. Writes `cluster_id` and `cluster_label` to SQLite (`wechat_moments_clusters` table)

## Output

- SQLite: `data/wechat.db` → `wechat_moments_clusters` table
- JSON summary: `data/moments-cluster-results.json`
