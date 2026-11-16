# Customizing categories

`categories.json` here is the built-in default. Copy it, edit it, and point Mail Triage at your copy:

```sh
cp examples/categories.json my-categories.json
mail-triage categories check my-categories.json   # validate without saving
# then either reload it before every cycle:
echo 'CATEGORIES_FILE=./my-categories.json' >> .env
# or save it once into the database:
mail-triage categories import my-categories.json
```

## Format

```jsonc
{
  "categories": [
    { "id": "receipt", "name": "Receipt", "description": "Receipts, invoices, order and payment confirmations." }
  ],
  "userContext": "I lead the platform team at Northwind; on-call alerts matter to me."
}
```

| Field | Rules |
| --- | --- |
| `categories` | 2 to 25 entries. |
| `id` | Lowercase letters, digits, and `_`, starting with a letter, up to 32 characters. Unique. Stored with every classification, so keep it stable when you rename. |
| `name` | 1 to 40 characters, no `/` or `\`. Unique (ignoring case). Becomes the Gmail label `Mail Triage/Category/<name>` and is the option the model sees. |
| `description` | 1 to 500 characters of plain English. This is what the model uses to decide, so say what belongs and what does not. |
| `userContext` | Optional, up to 2,000 characters about you: your role, who matters, what is urgent. It shapes the action and priority answers too. |

Unknown keys are rejected, so a typo cannot silently drop a setting. If the file is invalid, the saved categories stay exactly as they were and the cycle reports the error.

Action (Needs Response, Needs Action, No Action) and priority (Low, Normal, High) are fixed and labeled separately from the category.

## Tips

- Write descriptions that separate neighbors: "Automated alerts from a service" vs. "Personal or work updates written for me to read".
- Keep an `other` category so the model is not forced into a poor fit.
- Any change to the file (including `userContext`) creates a new revision. Messages in the current sync window are classified again, and their new labels are added next to the old ones. Mail Triage never removes labels, so remove outdated ones in Gmail if you want.
- Renaming a category creates a new Gmail label; the old label stays in Gmail until you delete it.
