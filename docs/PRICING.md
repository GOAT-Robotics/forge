# Vendors, rate cards and job-order estimates

Forge prices a job order from the geometry of its parts and a vendor's **rate card**. The estimate is for planning and
for comparing vendors; it is not a vendor's quotation.

## Rate cards

* **Base sheets** have no vendor. Forge ships one: *Coimbatore base sheet (Oct 2026)*. Copy a base sheet for another
  city or a new price list (*Vendors & pricing → Copy sheet*).
* **Vendor cards.** Adding a vendor copies a base sheet into the vendor's own card. Replace the rates with the vendor's
  quote; *Reset rates from…* copies a base sheet over it again. *CSV* exports any card for a spreadsheet or for a
  vendor to fill in.
* Who can edit: the `pricing.manage` permission (administrators, design engineers, production planners). Costs are
  shown to people who can create job orders or manage pricing; operators, viewers and vendor links never see them.

| Section | What it charges | How Forge uses it |
|---|---|---|
| Materials | ₹ per kg, density, the words that identify it in a part spec (`crca, is 513, cold rolled`) | The part's *Material / Stock* text is matched to a row; no match uses the card's default sheet or bar material and is listed as a warning. |
| Laser cutting | ₹ per metre of cut and per pierce, by thickness (mild steel) × material multiplier | Cut length = flat-pattern outline + every hole; pierces = 1 + holes. Minimum charge per part. |
| Bending | ₹ per press stroke by thickness, long-bend factor, setup per part number per job | Every press-brake bend is a stroke. |
| Rolling | ₹ per kg, minimum per part, setup per job | Bends rolled (R ≥ 10 t, or set to *Roll* in the forming sequence). |
| Machining | ₹ per hour, setup hours, handling minutes, minutes per feature, removal rate per material | Stock = bounding box + allowance per side; time = handling + removed volume ÷ removal rate + features. A rough estimate. |
| Drilling, tapping, countersinks | ₹ per hole by diameter / thread; tapping setup per job | Plain holes of machined parts are drilled; taps and countersinks come from the hole hardware. |
| Hardware | ₹ per piece by type and thread (`M3-M5`, `M6`, `*`); insertion per piece (press-in, rivnut, weld nut) | From the hole hardware set in *Holes & hardware*. |
| Welding | ₹ per metre and per tack by process and material | Weld length from the weld definitions (stitch welds count their stitches); ground welds add grinding per metre. |
| Finishes | ₹ per sq ft, per kg or per part, + per part, minimum per part, setup per job and colour | The part's *Finish / Paint* text is matched; powder and paint add the colour's extra per sq ft (RAL code, or `*`). Area is the part's full surface. |
| Quantity breaks | labour discount % from a quantity | Applied to labour lines (not material or bought hardware). |
| Overheads | sheet scrap %, vendor margin %, GST %, minimum order, transport | Margin is added to the subtotal, GST on top. |

## Using it

* **New job order:** the dialog prices the order at every vendor at once; pick one. The estimate is kept with the job
  order.
* **Job order page:** *Cost estimate* shows the total, the cost by process and per part (unit cost, setups) and
  anything Forge could not price. *Re-price* uses the current rates; the vendor menu changes the vendor; *Compare
  vendors* lists the order's total at every vendor.
* **A single part:** the part's *Cost* tab (side panel) shows the approximate cost to make one piece — split by
  process with each share, setups spread over the quantity, vendor margin and GST — plus the line items behind it, the
  cost per piece at 1 / 10 / 50 / 100 / 500 pieces and the same part at every vendor. Change the quantity or vendor
  there; nothing is saved. Transport and the minimum order are left out (they apply per job order).
* Bought-in parts are not priced.

## The base sheet

Indicative Coimbatore / Tamil Nadu job-work rates, October 2026, excluding GST. Market references used:

* Steel: Coimbatore HR sheet IS 2062 ₹53/kg (Bharathi Steel listing), CR sheet ≈ ₹69/kg (Tata nexarc, Coimbatore),
  CRCA ₹58–63/kg (OfBusiness), GI ₹64–67/kg (Coimbatore listings); SS 304 ₹180–260/kg; Al 5052 ₹205–450/kg.
* Laser cutting in Coimbatore is usually quoted per sq ft by thickness (e.g. ₹25/sq ft at 2 mm, ₹40 at 3 mm, ₹77 at
  6 mm); the card converts this to per metre of cut, which follows the real cost driver.
* Bending ₹7–10 per stroke (Coimbatore listing), CNC bending ₹5–20 per bend; plate rolling ₹6/kg.
* Powder coating ₹12–22/sq ft (Coimbatore and Chennai listings); zinc plating / galvanising ₹20–50/kg; anodising
  ₹10–30/sq ft; zinc phosphating ₹10/kg.
* MIG welding labour ₹200–700/h, TIG ₹400–1000/h; VMC job work ₹500–800/h.
* Clinch nuts ₹0.5–7, clinch studs ₹0.2–15, standoffs ₹2–8, weld nuts ₹0.2–6 per piece (generic, zinc-plated steel);
  genuine PEM hardware costs more.

Confirm every rate with your vendors before relying on an estimate.

## Design checks borrowed from fabricators' rules

* **Bend distortion zone (DFM006):** a hole closer than 2 t + r to a bend (measured from where the bend starts)
  stretches, shifts or goes out of round when the bend is formed. Move it, or accept the risk with a waiver.
* **Powder-coat hanging hole (DFM007):** a powder-coated part needs a hole of at least 2.2 mm to hang it, or a masked
  hanging point agreed with the coater.
