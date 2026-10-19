#!/usr/bin/env bash
# Creates the private repo <owner>/krill-sandbox with a review history, to test the onboarding end to end.
# Usage: bash seed.sh <owner> <working directory>
set -euo pipefail
OWNER=$1; WORK=$2; REPO="$OWNER/krill-sandbox"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
git init -q -b main

mkdir -p app tests
cat > app/__init__.py <<'PY'
PY
cat > app/utils.py <<'PY'
from decimal import Decimal, ROUND_HALF_UP


def round_currency(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def format_currency(value: Decimal, currency: str = "USD") -> str:
    return f"{round_currency(value):,.2f} {currency}"
PY
cat > app/repository.py <<'PY'
import sqlite3

DB_PATH = "app.db"


def get_user(user_id: int) -> dict | None:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT id, email FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"id": row[0], "email": row[1]} if row else None
PY
cat > app/services.py <<'PY'
import logging

from app import repository

logger = logging.getLogger(__name__)


def user_profile(user_id: int) -> dict | None:
    logger.info("Fetching profile %s", user_id)
    return repository.get_user(user_id)
PY
cat > app/handlers.py <<'PY'
from app import services


def get_profile(request) -> dict:
    profile = services.user_profile(int(request.params["id"]))
    if profile is None:
        return {"status": 404}
    return {"status": 200, "body": profile}
PY
cat > tests/test_handlers.py <<'PY'
from app.utils import round_currency
from decimal import Decimal


def test_rounding():
    assert round_currency(Decimal("1.005")) == Decimal("1.01")
PY
cat > AGENTS.md <<'MD'
# Agent guide

- Code lives in `app/` and tests in `tests/` (pytest).
- Use logging to record events.
MD
git add -A && git commit -qm "Initial service skeleton"

branch() { git checkout -q main && git checkout -q -b "$1"; }

# PR 1: users export with SQL in the handler and print
branch feature/export-users
cat >> app/handlers.py <<'PY'


def export_users(request) -> dict:
    import sqlite3
    conn = sqlite3.connect("app.db")
    rows = conn.execute("SELECT id, email FROM users").fetchall()
    print("Exporting", len(rows), "users")
    return {"status": 200, "body": [{"id": r[0], "email": r[1]} for r in rows]}
PY
git commit -qam "Add users export endpoint"

# PR 2: invoice totals with duplicated rounding and print
branch feature/invoice-totals
cat >> app/services.py <<'PY'


def invoice_total(lines: list[dict]) -> float:
    total = sum(l["price"] * l["quantity"] for l in lines)
    print("Computed total", total)
    return round(total + 0.0000001, 2)
PY
git commit -qam "Add invoice totals"

# PR 3: orders with SQL in the handler, float and no tests
branch feature/orders
cat >> app/handlers.py <<'PY'


def get_order(request) -> dict:
    import sqlite3
    conn = sqlite3.connect("app.db")
    row = conn.execute("SELECT id, total FROM orders WHERE id = ?", (request.params["id"],)).fetchone()
    total = float(row[1])
    return {"status": 200, "body": {"id": row[0], "total": total}}
PY
git commit -qam "Add order endpoint"

# PR 4: discounts with float, duplicated formatting and no tests
branch feature/discounts
cat >> app/services.py <<'PY'


def apply_discount(total: float, percent: float) -> str:
    final = total - total * percent / 100
    return "{:,.2f} USD".format(final)
PY
git commit -qam "Add discounts"

git checkout -q main
gh repo create "$REPO" --private --source . --push >/dev/null
git push -q origin feature/export-users feature/invoice-totals feature/orders feature/discounts

pr() { gh pr create -R "$REPO" -H "$1" -B main -t "$2" -b "$3" | grep -o '[0-9]*$'; }
comment() { # pr, branch, file, pattern, text
  local sha line
  sha=$(git rev-parse "$2")
  line=$(git show "$2:$3" | grep -nF -- "$4" | head -1 | cut -d: -f1)
  gh api "repos/$REPO/pulls/$1/comments" -f commit_id="$sha" -f path="$3" -F line="$line" -f side=RIGHT -f body="$5" >/dev/null
}

P1=$(pr feature/export-users "Export users" "Endpoint to export every user.")
comment "$P1" feature/export-users app/handlers.py 'conn.execute("SELECT id, email FROM users")' \
  "Handlers must not talk to the database directly. Move this query to app/repository.py and call it from a service in app/services.py."
comment "$P1" feature/export-users app/handlers.py 'print("Exporting"' \
  "Don't use print in app code; use logger = logging.getLogger(__name__) like services.py does."

P2=$(pr feature/invoice-totals "Invoice totals" "Computes an invoice's total.")
comment "$P2" feature/invoice-totals app/services.py 'return round(total' \
  "round_currency() already exists in app/utils.py; reuse it instead of duplicating the rounding here."
comment "$P2" feature/invoice-totals app/services.py 'print("Computed total"' \
  "print again: use the module's logger so we can control log levels in production."
comment "$P2" feature/invoice-totals app/services.py 'def invoice_total' \
  "Use Decimal for amounts, never float: rounding errors add up on invoices."

P3=$(pr feature/orders "Orders endpoint" "Returns an order by id.")
comment "$P3" feature/orders app/handlers.py 'conn.execute("SELECT id, total FROM orders' \
  "Same problem as in the users endpoint: data access belongs in app/repository.py, not in the handler."
comment "$P3" feature/orders app/handlers.py 'total = float(row[1])' \
  "Don't convert the total to float; use Decimal end to end for money."
comment "$P3" feature/orders app/handlers.py 'def get_order' \
  "Add a test in tests/ for the case where the order doesn't exist; right now row can be None."

P4=$(pr feature/discounts "Discounts" "Applies a percentage discount.")
comment "$P4" feature/discounts app/services.py 'def apply_discount' \
  "Use Decimal for amounts and percentages; float already caused cent differences in the invoices PR."
comment "$P4" feature/discounts app/services.py 'return "{:,.2f} USD"' \
  "This formatting already exists in app/utils.py (format_currency); don't duplicate it."
comment "$P4" feature/discounts app/services.py 'final = total - total' \
  "Missing a test in tests/ for a discount above 100%; right now it would return a negative total."

echo "Repo ready: https://github.com/$REPO (PRs #$P1 #$P2 #$P3 #$P4)"
