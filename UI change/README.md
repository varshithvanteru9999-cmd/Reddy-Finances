# REDDY FINANCES — PREMIUM UI UPGRADE

This folder stores every change made during the "rich & premium" visual upgrade
of the **public site only** (home, vehicle detail, and sign-contract pages).
The admin dashboard was intentionally left untouched.

Everything here is saved so you can restore the previous look at any time.

---

## What changed (and why it’s safe)

### 1. New file: `css/premium.css`
A brand-new stylesheet layered **on top of** the existing `css/style.css`.
It does **not** modify or delete anything in the original CSS. It only overrides
visual properties while keeping every class name, DOM element and feature intact.

**Because of this, all functionality is preserved:**
- Home page captures (hero video, image placeholders, marquee, fleet grid)
- Vehicle detail page, booking form, live quote, viewing requests
- Authentication (Firebase), Google sign-in, user chip / dropdown
- All routes, all API calls, all business logic
- Responsive behaviour on desktop / tablet / mobile

To REVERT to the old look, simply delete the `<link>` tags added to the HTML
(see below) and delete `css/premium.css`. Nothing else needs undoing.

### 2. HTML files — one `<link>` added after `style.css`
The following files now load `premium.css` second, so it wins:

| File | Change |
|------|--------|
| `index.html` | `<link rel="stylesheet" href="css/premium.css">` added |
| `car.html`   | `<link rel="stylesheet" href="css/premium.css">` added |
| `temp.html`  | `<link rel="stylesheet" href="css/premium.css">` added (mirror of index) |
| `sign-contract.html` | link added **and** its inline `<style>` upgraded to the premium palette |

### 3. `sign-contract.html`
In addition to the link, the inline styles were upgraded to the premium theme:
dark glass cards, gold headings, gradient primary button, refined progress steps,
premium file-upload panels and status messages. The header was made static so the
logo sits correctly on this page. Functionality (upload, validation, progress
updates) is unchanged.

---

## Design direction applied
- **Deep red** remains the primary brand accent (rich gradient: `#FF2B37 → #C10410 → #8F030C`)
- **Near-black / charcoal** grounds: `#0A0B0D`, `#0E1013`, graphite `#1A1E24`
- **Subtle metallic gold / champagne** used sparingly (`#C9A96A` + gradient):
  eyebrows, card hover rules, buy-card rule, block titles, marquee separators
- Premium cards with hairline borders, deep soft shadows, gold hover accent
- Tasteful glassmorphism on the header, menu, badges, fav buttons, auth modal
- Refined typography: strong hierarchy, serif italic accents on key headings,
  wide-tracked caps eyebrows
- Restrained micro-interactions (lift + glow on hover), never flashy

---

## How to apply / revert

### Apply
The changes are already live in the working folder. No action needed.

### Revert (restore the old look)
1. In `index.html`, `car.html`, `temp.html`, delete this line:
   `<link rel="stylesheet" href="css/premium.css">`
2. In `sign-contract.html`, delete the same line.
3. Delete the file `css/premium.css`.
4. (Optional) Restore the original `sign-contract.html` inline styles from the
   backup below.

---

## File locations in this folder

```
UI change/
├── _original_backup/          # untouched copies of the files BEFORE the upgrade
│   ├── index.html.original
│   ├── car.html.original
│   ├── sign-contract.html.original
│   └── style.css.original
├── css/
│   └── premium.css            # the new premium stylesheet (also in css/)
├── index.html.new             # index.html with the premium link applied
├── car.html.new               # car.html with the premium link applied
├── temp.html.new              # temp.html with the premium link applied
└── sign-contract.html.new     # sign-contract.html with premium styles applied
```

To "old version" anything: copy the file from `_original_backup/` back over the
live file (rename back to the real filename, e.g. `style.css.original` →
`css/style.css`).

---

**Summary:** one new CSS file + one link in four HTML pages. Everything else is
untouched. To go back to the pre-upgrade look, undo those five small changes.
