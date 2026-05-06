"""
Reddit Sentiment Analysis Tool
===============================
Uses Reddit's public .json endpoints (no API key required)
+ VADER sentiment analysis.

Usage:
    python reddit_sentiment.py --query "bitcoin" --source search --limit 50
    python reddit_sentiment.py --query "technology" --source subreddit --limit 30
    python reddit_sentiment.py --query "artificial intelligence" --source search --limit 100
"""

import requests
import time
import argparse
import json
import csv
import os
from datetime import datetime
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

# ─── Configuration ───────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "SentimentAnalyzer/1.0 (personal research project)"
}
REQUEST_DELAY = 2  # seconds between requests to be respectful


# ─── Reddit Data Fetching ────────────────────────────────────────────────────

def fetch_reddit_search(query, limit=50):
    """Fetch posts from Reddit search results."""
    posts = []
    after = None
    per_page = min(limit, 100)

    while len(posts) < limit:
        url = "https://www.reddit.com/search.json"
        params = {
            "q": query,
            "sort": "relevance",
            "t": "week",       # time filter: hour, day, week, month, year, all
            "limit": per_page,
        }
        if after:
            params["after"] = after

        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"  [!] Request error: {e}")
            break

        children = data.get("data", {}).get("children", [])
        if not children:
            break

        for child in children:
            p = child["data"]
            posts.append({
                "title": p.get("title", ""),
                "selftext": p.get("selftext", ""),
                "subreddit": p.get("subreddit", ""),
                "score": p.get("score", 0),
                "num_comments": p.get("num_comments", 0),
                "created_utc": p.get("created_utc", 0),
                "url": f"https://reddit.com{p.get('permalink', '')}",
            })

        after = data.get("data", {}).get("after")
        if not after:
            break
        time.sleep(REQUEST_DELAY)

    return posts[:limit]


def fetch_subreddit_posts(subreddit, limit=50, sort="hot"):
    """Fetch posts from a specific subreddit."""
    posts = []
    after = None
    per_page = min(limit, 100)

    while len(posts) < limit:
        url = f"https://www.reddit.com/r/{subreddit}/{sort}.json"
        params = {"limit": per_page}
        if after:
            params["after"] = after

        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"  [!] Request error: {e}")
            break

        children = data.get("data", {}).get("children", [])
        if not children:
            break

        for child in children:
            p = child["data"]
            posts.append({
                "title": p.get("title", ""),
                "selftext": p.get("selftext", ""),
                "subreddit": p.get("subreddit", ""),
                "score": p.get("score", 0),
                "num_comments": p.get("num_comments", 0),
                "created_utc": p.get("created_utc", 0),
                "url": f"https://reddit.com{p.get('permalink', '')}",
            })

        after = data.get("data", {}).get("after")
        if not after:
            break
        time.sleep(REQUEST_DELAY)

    return posts[:limit]


def fetch_post_comments(permalink, limit=20):
    """Fetch top comments for a specific post."""
    url = f"https://www.reddit.com{permalink}.json"
    params = {"limit": limit, "sort": "top"}
    comments = []

    try:
        resp = requests.get(url, headers=HEADERS, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        if len(data) > 1:
            for child in data[1].get("data", {}).get("children", []):
                if child["kind"] == "t1":
                    c = child["data"]
                    comments.append({
                        "body": c.get("body", ""),
                        "score": c.get("score", 0),
                    })
    except Exception as e:
        print(f"  [!] Comment fetch error: {e}")

    return comments


# ─── Sentiment Analysis ──────────────────────────────────────────────────────

def analyze_sentiment(texts):
    """Run VADER sentiment analysis on a list of texts."""
    analyzer = SentimentIntensityAnalyzer()
    results = []

    for text in texts:
        if not text or not text.strip():
            continue
        scores = analyzer.polarity_scores(text)
        # Classify based on compound score
        compound = scores["compound"]
        if compound >= 0.05:
            label = "POSITIVE"
        elif compound <= -0.05:
            label = "NEGATIVE"
        else:
            label = "NEUTRAL"

        results.append({
            "text": text[:200],  # truncate for display
            "compound": compound,
            "positive": scores["pos"],
            "negative": scores["neg"],
            "neutral": scores["neu"],
            "label": label,
        })

    return results


def compute_summary(results):
    """Compute overall sentiment summary statistics."""
    if not results:
        return {}

    total = len(results)
    pos_count = sum(1 for r in results if r["label"] == "POSITIVE")
    neg_count = sum(1 for r in results if r["label"] == "NEGATIVE")
    neu_count = sum(1 for r in results if r["label"] == "NEUTRAL")
    avg_compound = sum(r["compound"] for r in results) / total

    return {
        "total_analyzed": total,
        "positive": pos_count,
        "negative": neg_count,
        "neutral": neu_count,
        "positive_pct": round(pos_count / total * 100, 1),
        "negative_pct": round(neg_count / total * 100, 1),
        "neutral_pct": round(neu_count / total * 100, 1),
        "avg_compound_score": round(avg_compound, 4),
        "overall_sentiment": "POSITIVE" if avg_compound >= 0.05 else ("NEGATIVE" if avg_compound <= -0.05 else "NEUTRAL"),
    }


# ─── Output ──────────────────────────────────────────────────────────────────

def print_report(query, source, summary, top_positive, top_negative):
    """Print a formatted sentiment report."""
    print("\n" + "=" * 65)
    print(f"  REDDIT SENTIMENT ANALYSIS REPORT")
    print(f"  Query: '{query}'  |  Source: {source}")
    print(f"  Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 65)

    if not summary:
        print("\n  No data found. Try a different query or source.\n")
        return

    print(f"\n  Total texts analyzed: {summary['total_analyzed']}")
    print(f"  Average compound score: {summary['avg_compound_score']}")
    print(f"  Overall sentiment: {summary['overall_sentiment']}")
    print()

    # Bar chart
    bar_width = 40
    pos_bar = "█" * int(summary["positive_pct"] / 100 * bar_width)
    neg_bar = "█" * int(summary["negative_pct"] / 100 * bar_width)
    neu_bar = "█" * int(summary["neutral_pct"] / 100 * bar_width)

    print(f"  Positive  {pos_bar} {summary['positive_pct']}% ({summary['positive']})")
    print(f"  Negative  {neg_bar} {summary['negative_pct']}% ({summary['negative']})")
    print(f"  Neutral   {neu_bar} {summary['neutral_pct']}% ({summary['neutral']})")

    if top_positive:
        print(f"\n  {'─' * 60}")
        print(f"  TOP POSITIVE (compound={top_positive['compound']}):")
        print(f"  \"{top_positive['text']}\"")

    if top_negative:
        print(f"\n  {'─' * 60}")
        print(f"  TOP NEGATIVE (compound={top_negative['compound']}):")
        print(f"  \"{top_negative['text']}\"")

    print("\n" + "=" * 65)


def save_csv(results, filename):
    """Save detailed results to CSV."""
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["text", "label", "compound", "positive", "negative", "neutral"])
        writer.writeheader()
        writer.writerows(results)
    print(f"\n  Results saved to: {filename}")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Reddit Sentiment Analysis (no API key needed)")
    parser.add_argument("--query", "-q", required=True, help="Search query or subreddit name")
    parser.add_argument("--source", "-s", choices=["search", "subreddit"], default="search",
                        help="'search' = Reddit search, 'subreddit' = specific subreddit")
    parser.add_argument("--limit", "-l", type=int, default=30, help="Number of posts to fetch (default: 30)")
    parser.add_argument("--comments", "-c", action="store_true", help="Also analyze top comments (slower)")
    parser.add_argument("--csv", type=str, help="Save results to CSV file")
    args = parser.parse_args()

    print(f"\n  Fetching Reddit data for '{args.query}'...")

    # Fetch posts
    if args.source == "search":
        posts = fetch_reddit_search(args.query, args.limit)
    else:
        posts = fetch_subreddit_posts(args.query, args.limit)

    print(f"  Found {len(posts)} posts.")

    if not posts:
        print("  No posts found. Try a different query.\n")
        return

    # Collect texts for analysis
    texts = []
    for p in posts:
        combined = p["title"]
        if p["selftext"]:
            combined += " " + p["selftext"]
        texts.append(combined)

    # Optionally fetch comments
    if args.comments:
        print(f"  Fetching comments (this may take a moment)...")
        for p in posts[:10]:  # limit to first 10 posts for speed
            permalink = p["url"].replace("https://reddit.com", "")
            comments = fetch_post_comments(permalink, limit=10)
            for c in comments:
                if c["body"]:
                    texts.append(c["body"])
            time.sleep(REQUEST_DELAY)
        print(f"  Total texts (posts + comments): {len(texts)}")

    # Analyze
    print(f"  Running VADER sentiment analysis...")
    results = analyze_sentiment(texts)
    summary = compute_summary(results)

    # Find extremes
    top_positive = max(results, key=lambda r: r["compound"]) if results else None
    top_negative = min(results, key=lambda r: r["compound"]) if results else None

    # Report
    print_report(args.query, args.source, summary, top_positive, top_negative)

    # Save CSV if requested
    if args.csv:
        save_csv(results, args.csv)


if __name__ == "__main__":
    main()
