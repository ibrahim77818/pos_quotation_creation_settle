# POS Quotation Creation & Validity-Governed Settlement

`pos_quotation_creation_settle` turns a Point of Sale cart into a Sales quotation (no payment), prints a quotation
receipt and downloads the quotation PDF. When the customer comes back, the quotation is settled through
**Quotation/Order**, with a validity period that can warn the cashier or block settlement at outdated prices.

Odoo **16.0**, Community and Enterprise. English and Arabic.

## Branches

| Branch | Odoo version |
|---|---|
| `16.0` (default) | 16.0 |
| `17.0` | 17.0 |
| `18.0` | 18.0 |
| `19.0` | 19.0 |
| `20.0` | 20.0 |

## Features
- **Create Quotation** in the POS: draft `sale.order` without payment, shop tag, cashier as salesperson, POS sales team.
- POS quotation receipt (no payment lines) and downloadable quotation PDF.
- Validity period in hours or days; the Sales **Expiration** date drives the POS expiry.
- **Alert Only** or **Block Same-Price Settlement** (settle only at the current, server-computed price).
- Checks when the quotation is loaded, before payment (also offline) and when the order syncs.
- Optional stock check before settlement.

## Installation
1. Copy the `pos_quotation_creation_settle` folder of this branch into your addons path.
2. Restart Odoo and update the apps list.
3. Install **POS Quotation Creation & Validity-Governed Settlement** (depends on `pos_sale`).
4. Configure it in **Point of Sale › Configuration › Settings › POS Quotations**.

Run the tests:

```
odoo-bin -d <db> -i pos_quotation_creation_settle --test-enable --test-tags /pos_quotation_creation_settle --stop-after-init
```

## Author
Ibrahim Yahia · [LinkedIn](https://www.linkedin.com/in/ibrahim-yahia) · License: LGPL-3

