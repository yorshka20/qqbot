#!/usr/bin/env python3
"""
Moments Content Clustering Script

Clusters WeChat moments by vector similarity using K-Means,
then uses LLM to generate a label for each cluster.
Results are written to SQLite (wechat_moments_clusters table).

Usage:
    python scripts/clustering/moments_cluster.py
    python scripts/clustering/moments_cluster.py --k 15
    python scripts/clustering/moments_cluster.py --auto-k
    python scripts/clustering/moments_cluster.py --provider deepseek
    python scripts/clustering/moments_cluster.py --dry-run
"""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
import requests
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

COLLECTION = "wechat_moments"
DEFAULT_K = 10
DEFAULT_DB_PATH = "data/wechat.db"
DEFAULT_OUTPUT = "data/moments-cluster-results.json"


def load_config(config_path: str = "config.jsonc") -> dict:
    """Load JSONC config (strip comments)."""
    path = os.environ.get("CONFIG_PATH", config_path)
    text = Path(path).read_text(encoding="utf-8")
    # Strip single-line comments (// ...) but not inside strings
    import re
    # Remove lines that are only comments or trailing comments
    lines = []
    for line in text.split("\n"):
        # Remove trailing // comments (naive but works for our config format)
        stripped = re.sub(r'(?<!:)//.*$', '', line)
        lines.append(stripped)
    cleaned = "\n".join(lines)
    return json.loads(cleaned)


def resolve_provider(config: dict, provider_key: str, model_override: str = None) -> dict:
    """Resolve LLM provider from config."""
    providers = config.get("ai", {}).get("providers", {})

    # Try exact key match
    if provider_key in providers:
        p = providers[provider_key]
    else:
        # Try matching by type
        p = next((v for v in providers.values() if v.get("type") == provider_key), None)
        if not p:
            available = ", ".join(providers.keys())
            raise ValueError(f'Provider "{provider_key}" not found. Available: {available}')

    base_url = (p.get("baseUrl") or p.get("baseURL") or "").rstrip("/")
    if not base_url:
        raise ValueError(f'Provider "{provider_key}" has no baseUrl configured')

    return {
        "type": p.get("type", provider_key),
        "base_url": base_url,
        "api_key": p.get("apiKey"),
        "model": model_override or p.get("model", ""),
    }


# ---------------------------------------------------------------------------
# Qdrant: scroll with vectors
# ---------------------------------------------------------------------------

def qdrant_scroll_all(qdrant_url: str, collection: str, limit: int = 0) -> list[dict]:
    """Scroll all points from Qdrant collection WITH vectors."""
    qdrant_url = qdrant_url.rstrip("/")
    all_points = []
    offset = None
    page_size = 100

    while True:
        body = {
            "limit": page_size,
            "with_payload": {"include": ["content", "create_time"]},
            "with_vector": True,
        }
        if offset is not None:
            body["offset"] = offset

        resp = requests.post(
            f"{qdrant_url}/collections/{collection}/points/scroll",
            json=body,
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()

        points = data.get("result", {}).get("points", [])
        if not points:
            break

        all_points.extend(points)
        print(f"  Scrolled {len(all_points)} points...", end="\r")

        if 0 < limit <= len(all_points):
            all_points = all_points[:limit]
            break

        next_offset = data.get("result", {}).get("next_page_offset")
        if next_offset is None:
            break
        offset = next_offset

    print(f"  Scrolled {len(all_points)} points total")
    return all_points


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def find_optimal_k(vectors: np.ndarray, k_range: range) -> int:
    """Find optimal k using silhouette score."""
    print(f"Auto-detecting optimal k in range {k_range.start}-{k_range.stop - 1}...")
    best_k = k_range.start
    best_score = -1

    for k in k_range:
        km = KMeans(n_clusters=k, n_init=5, max_iter=100, random_state=42)
        labels = km.fit_predict(vectors)
        score = silhouette_score(vectors, labels, sample_size=min(2000, len(vectors)))
        print(f"  k={k:3d}  silhouette={score:.4f}")
        if score > best_score:
            best_score = score
            best_k = k

    print(f"  Best k={best_k} (silhouette={best_score:.4f})")
    return best_k


def run_clustering(vectors: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Run K-Means and return (labels, centroids)."""
    print(f"Running K-Means with k={k}...")
    km = KMeans(n_clusters=k, n_init=10, max_iter=300, random_state=42)
    labels = km.fit_predict(vectors)
    print(f"  Clustering done. Cluster sizes: {np.bincount(labels).tolist()}")
    return labels, km.cluster_centers_


def get_representative_samples(
    points: list[dict], vectors: np.ndarray, labels: np.ndarray, centroids: np.ndarray, n_samples: int = 5
) -> dict[int, list[dict]]:
    """For each cluster, find the n closest points to the centroid."""
    samples = {}
    for cluster_id in range(len(centroids)):
        mask = labels == cluster_id
        indices = np.where(mask)[0]
        if len(indices) == 0:
            samples[cluster_id] = []
            continue

        cluster_vectors = vectors[indices]
        centroid = centroids[cluster_id]
        distances = np.linalg.norm(cluster_vectors - centroid, axis=1)
        closest = np.argsort(distances)[:n_samples]

        samples[cluster_id] = [
            {
                "id": points[indices[i]]["id"],
                "content": (points[indices[i]].get("payload", {}).get("content") or "")[:300],
                "distance": float(distances[i]),
            }
            for i in closest
        ]
    return samples


# ---------------------------------------------------------------------------
# LLM: generate cluster labels
# ---------------------------------------------------------------------------

def call_llm(provider: dict, prompt: str) -> str:
    """Call LLM (ollama or openai-compatible) and return response text."""
    if provider["type"] == "ollama":
        resp = requests.post(
            f'{provider["base_url"]}/api/chat',
            json={
                "model": provider["model"],
                "messages": [{"role": "user", "content": f"{prompt}\n\n/no_think"}],
                "stream": False,
                "options": {"num_predict": 2048, "temperature": 0.3},
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json().get("message", {}).get("content", "")
    else:
        # OpenAI-compatible (deepseek, doubao, etc.)
        base_url = provider["base_url"]
        if base_url.endswith(("/v1", "/v3")):
            endpoint = f"{base_url}/chat/completions"
        else:
            endpoint = f"{base_url}/v1/chat/completions"

        headers = {"Content-Type": "application/json"}
        if provider.get("api_key"):
            headers["Authorization"] = f'Bearer {provider["api_key"]}'

        resp = requests.post(
            endpoint,
            headers=headers,
            json={
                "model": provider["model"],
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 2048,
                "temperature": 0.3,
            },
            timeout=60,
        )
        resp.raise_for_status()
        choices = resp.json().get("choices", [])
        return choices[0]["message"]["content"] if choices else ""


def generate_cluster_labels(
    provider: dict, samples: dict[int, list[dict]]
) -> dict[int, str]:
    """Use LLM to generate a short label for each cluster based on sample content."""
    labels = {}

    # Build a single prompt for all clusters
    parts = []
    for cluster_id, cluster_samples in sorted(samples.items()):
        if not cluster_samples:
            labels[cluster_id] = "未分类"
            continue
        content_list = "\n".join(
            f"  - {s['content'][:200]}" for s in cluster_samples
        )
        parts.append(f"[Cluster {cluster_id}]\n{content_list}")

    if not parts:
        return labels

    prompt = (
        "以下是按向量相似度聚类后的朋友圈内容分组。每个 Cluster 包含几条代表性内容。\n"
        "请为每个 Cluster 生成一个简短的中文标签（2-6个字），概括该组内容的共同主题。\n\n"
        "输出格式（严格 JSON 对象，不要输出其他内容）：\n"
        '{"0": "标签A", "1": "标签B", ...}\n\n'
        + "\n\n".join(parts)
    )

    print("Generating cluster labels via LLM...")
    text = call_llm(provider, prompt)

    # Extract JSON object from response
    import re
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            parsed = json.loads(match.group())
            for k, v in parsed.items():
                labels[int(k)] = str(v)
        except (json.JSONDecodeError, ValueError) as e:
            print(f"  Warning: Failed to parse LLM response: {e}")
            print(f"  Raw response: {text[:300]}")

    # Fill in any missing labels
    for cluster_id in samples:
        if cluster_id not in labels:
            labels[cluster_id] = f"聚类 {cluster_id}"

    return labels


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

def write_to_sqlite(
    db_path: str,
    assignments: list[tuple[str, int, str]],  # (moment_id, cluster_id, cluster_label)
):
    """Write cluster assignments to SQLite."""
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wechat_moments_clusters (
            moment_id     TEXT PRIMARY KEY,
            cluster_id    INTEGER NOT NULL,
            cluster_label TEXT    NOT NULL DEFAULT '',
            clustered_at  TEXT    NOT NULL DEFAULT ''
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mc_cluster_id ON wechat_moments_clusters(cluster_id)")

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    conn.executemany(
        """INSERT INTO wechat_moments_clusters (moment_id, cluster_id, cluster_label, clustered_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(moment_id) DO UPDATE SET
             cluster_id=excluded.cluster_id,
             cluster_label=excluded.cluster_label,
             clustered_at=excluded.clustered_at""",
        [(mid, cid, label, now) for mid, cid, label in assignments],
    )
    conn.commit()
    conn.close()
    print(f"  Wrote {len(assignments)} assignments to {db_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Cluster WeChat moments by vector similarity")
    parser.add_argument("--k", type=int, default=DEFAULT_K, help=f"Number of clusters (default: {DEFAULT_K})")
    parser.add_argument("--auto-k", action="store_true", help="Auto-detect optimal k via silhouette score")
    parser.add_argument("--k-min", type=int, default=5, help="Min k for auto-detection (default: 5)")
    parser.add_argument("--k-max", type=int, default=25, help="Max k for auto-detection (default: 25)")
    parser.add_argument("--provider", default="ollama", help="LLM provider for label generation (default: ollama)")
    parser.add_argument("--model", default=None, help="Override LLM model")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of points (0=all)")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to SQLite")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help=f"SQLite DB path (default: {DEFAULT_DB_PATH})")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help=f"Output JSON path (default: {DEFAULT_OUTPUT})")
    args = parser.parse_args()

    # Load config
    config = load_config()
    if not config.get("rag", {}).get("enabled"):
        print("RAG is not enabled in config. Exiting.", file=sys.stderr)
        sys.exit(1)

    qdrant_url = config["rag"]["qdrant"]["url"]
    provider = resolve_provider(config, args.provider, args.model)

    print("=== Moments Content Clustering ===")
    print(f"Qdrant:     {qdrant_url}")
    print(f"Provider:   {args.provider} ({provider['type']})")
    print(f"Model:      {provider['model']}")
    print(f"K:          {'auto' if args.auto_k else args.k}")
    print(f"Limit:      {args.limit or 'all'}")
    print(f"Dry run:    {args.dry_run}")
    print()

    # Step 1: Scroll all points with vectors
    print("[1/4] Fetching points with vectors from Qdrant...")
    points = qdrant_scroll_all(qdrant_url, COLLECTION, args.limit)

    if len(points) < 10:
        print(f"Only {len(points)} points found, need at least 10 for clustering. Exiting.")
        sys.exit(1)

    # Extract vectors and validate
    vectors = []
    valid_points = []
    for p in points:
        vec = p.get("vector")
        if vec and isinstance(vec, list) and len(vec) > 0:
            vectors.append(vec)
            valid_points.append(p)

    if len(vectors) < 10:
        print(f"Only {len(vectors)} points have vectors. Exiting.")
        sys.exit(1)

    print(f"  {len(vectors)} points with vectors (dim={len(vectors[0])})")
    X = np.array(vectors, dtype=np.float32)

    # Step 2: Cluster
    print("\n[2/4] Clustering...")
    if args.auto_k:
        k = find_optimal_k(X, range(args.k_min, args.k_max + 1))
    else:
        k = min(args.k, len(vectors))

    labels, centroids = run_clustering(X, k)

    # Step 3: Get representative samples and generate labels
    print("\n[3/4] Generating cluster labels...")
    samples = get_representative_samples(valid_points, X, labels, centroids, n_samples=5)
    cluster_labels = generate_cluster_labels(provider, samples)

    for cid in sorted(cluster_labels.keys()):
        count = int(np.sum(labels == cid))
        print(f"  Cluster {cid:2d}: {cluster_labels[cid]:20s} ({count} items)")

    # Step 4: Write results
    print("\n[4/4] Writing results...")
    assignments = [
        (str(valid_points[i]["id"]), int(labels[i]), cluster_labels.get(int(labels[i]), ""))
        for i in range(len(valid_points))
    ]

    if not args.dry_run:
        write_to_sqlite(args.db, assignments)
    else:
        print("  (Dry run — skipping SQLite write)")

    # Write summary JSON
    summary = {
        "k": k,
        "auto_k": args.auto_k,
        "total_points": len(valid_points),
        "provider": args.provider,
        "model": provider["model"],
        "dry_run": args.dry_run,
        "clusters": [
            {
                "id": cid,
                "label": cluster_labels.get(cid, ""),
                "count": int(np.sum(labels == cid)),
                "samples": [s["content"][:150] for s in samples.get(cid, [])[:3]],
            }
            for cid in range(k)
        ],
    }

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    Path(args.output).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"  Summary: {args.output}")

    print("\n=== Done ===")


if __name__ == "__main__":
    main()
