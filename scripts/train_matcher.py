"""Fit the matcher's candidate-scoring model.

A linear scorer over the matcher features is trained with a listwise softmax
loss (each query's candidates compete; any row with the true brand label is a
correct answer), then a per-query logistic calibration maps scores to a
probability used for the confidence label.

Input : data/processed/match_pairs.jsonl  (from eval/export_match_pairs.js)
Output: app/public/models/matcher.json     (weights loaded by the app)

Queries are split by id into fit / validation parts; the report shows top-1
accuracy per query on the validation part, compared with ranking by the
brand-word similarity feature alone (a plain fuzzy-match baseline).
"""
import datetime as dt
import json
import pathlib
import random
from collections import defaultdict

import numpy as np
import torch
from sklearn.linear_model import LogisticRegression

ROOT = pathlib.Path(__file__).resolve().parent.parent
FEATURES = ["famSim", "famExact", "wordDice", "labelNumsFound", "queryNumsExplained", "extraLabelWords",
            "extraQueryWords", "formAgree", "formConflict", "packAgree", "packConflict", "lenRatio", "famPrefix"]


def top1(groups, scorer):
    ok = 0
    for rows in groups.values():
        xs = np.array([r["x"] for r in rows])
        ys = np.array([r["y"] for r in rows])
        s = scorer(xs)
        ok += int(ys[int(np.argmax(s))] == 1)
    return ok / max(1, len(groups))


def main():
    rows = [json.loads(l) for l in (ROOT / "data/processed/match_pairs.jsonl").read_text().splitlines() if l.strip()]
    groups = defaultdict(list)
    for r in rows:
        groups[r["qid"]].append(r)
    qids = sorted(groups)
    random.Random(0).shuffle(qids)
    cut = int(len(qids) * 0.8)
    fit_q, val_q = set(qids[:cut]), set(qids[cut:])
    def listwise(qset, epochs=300):
        qs = [groups[q] for q in qset]
        Xs = [torch.tensor([r["x"] for r in g], dtype=torch.float32) for g in qs]
        Ys = [torch.tensor([r["y"] for r in g], dtype=torch.bool) for g in qs]
        w = torch.zeros(len(FEATURES), requires_grad=True)
        opt = torch.optim.Adam([w], lr=0.05)
        for ep in range(epochs):
            opt.zero_grad()
            loss = 0.0
            for x, yv in zip(Xs, Ys):
                s_ = x @ w
                loss = loss + (torch.logsumexp(s_, 0) - torch.logsumexp(s_[yv], 0))
            loss = loss / len(Xs) + 1e-3 * (w ** 2).sum()
            loss.backward()
            opt.step()
        return w.detach().numpy()

    w_fit = listwise(fit_q)
    val = {q: groups[q] for q in val_q}
    acc_model = top1(val, lambda xs: xs @ w_fit)
    acc_base = top1(val, lambda xs: xs[:, 0] + 1e-3 * xs[:, 2])
    # shipped model: fit on all queries, then calibrate score -> P(correct) for the top candidate
    w_all = listwise(set(qids))
    tops, margins, correct = [], [], []
    for g in groups.values():
        xs = np.array([r["x"] for r in g]); ys = np.array([r["y"] for r in g])
        sc = xs @ w_all
        order = np.argsort(-sc)
        tops.append(sc[order[0]]); margins.append(sc[order[0]] - (sc[order[1]] if len(sc) > 1 else sc[order[0]] - 5))
        correct.append(int(ys[order[0]] == 1))
    cal = LogisticRegression().fit(np.array([tops]).T, np.array(correct))
    a_, b_ = float(cal.coef_[0][0]), float(cal.intercept_[0])
    # fold calibration into the linear weights: p = sigmoid(a*(w.x) + b)
    weights = {"bias": b_}
    weights.update({k: float(a_ * v) for k, v in zip(FEATURES, w_all)})
    out = {
        "model": "linear scorer over matcher features, listwise softmax loss, logistic calibration",
        "trained_on": f"{len(groups)} queries ({len(rows)} candidate pairs) from train-split OCR output and simulated OCR noise",
        "validation_top1": {"model": round(acc_model, 4), "fuzzy_brand_word_only": round(acc_base, 4), "queries": len(val_q)},
        "date": dt.date.today().isoformat(),
        "features": FEATURES,
        "weights": weights,
    }
    p = ROOT / "app/public/models/matcher.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
