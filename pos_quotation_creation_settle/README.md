# POS Quotation Creation & Validity-Governed Settlement (`pos_quotation_creation_settle`)

Odoo 16 Community & Enterprise. Depends on `pos_sale` only; `pos_hr` is optional.

## Configuration
*Point of Sale › Configuration › Settings › POS Quotations* (per POS):

| Setting | Default | Notes |
|---|---|---|
| Create Quotation from POS | off | Shows **Create Quotation** in the product screen control buttons |
| Cashier Without Linked User | Use the logged-in POS user | or *Block quotation creation* |
| Download Quotation PDF Automatically | on | |
| Quotation Validity Period | off | Only active while quotation creation is on |
| Validity Duration / Unit | 7 days | hours or days |
| Validity Expiry Governance | Alert Only | or *Block Same-Price Settlement* |
| Check Stock Before Settlement | off | Checks storable stock in the POS source location before payment |

## Flow
1. **Create Quotation** (cart + customer): `sale.order.pqs_create_quotation_from_pos` creates a draft
   quotation. No `pos.order`, `pos.payment` or invoice is created. Assigned: a `crm.tag` named after the POS (reused
   case-insensitively, created if missing), salesperson = the cashier's linked user (pos_hr) or the logged-in user,
   Sales Team = `pos.config.crm_team_id`. Expiry is stamped (`pqs_expiry_datetime` + `validity_date`). Repeated calls
   for the same cart return the same quotation (`pqs_pos_uid`).
2. The quotation receipt screen prints a POS receipt with no payment lines and downloads the quotation PDF
   (`/pos_quotation_creation_settle/quotation/<id>/pdf?access_token=…`). **New Order** closes the cart; a converted
   cart cannot be paid.
3. **Expiry**: the POS expiry follows the Sales *Expiration* date (changing it in Sales extends or shortens it).
   Order of precedence: POS expiry → Sales Expiration (end of day) → POS validity period from the quotation date.
4. **Quotation/Order › select order**: the server check (`pqs_check_pos_settlement`) blocks cancelled or fully settled
   quotations. Expired quotations either show a warning (Alert Only) or must be settled at the **current price
   computed by the server** (quotation pricelist + today's product prices, no discount); the down-payment choice is
   skipped (Block Same-Price). After sync the quotation lines take the collected prices, so totals match.
5. The verdict is stored on the cart, so the payment screen enforces Block mode even offline. The same rules run again before payment (`pos.order.pqs_validate_settlement`) and, authoritatively, when the
   order syncs (`pos.order._process_order`). Settlements made after expiry are logged in the quotation chatter.

Expiry applies only to quotations (draft/sent).

## Tests
`odoo-bin -d <db> -i pos_quotation_creation_settle --test-enable --test-tags /pos_quotation_creation_settle --stop-after-init`
