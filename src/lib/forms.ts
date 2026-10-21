/**
 * The sheets, as data.
 *
 * Every label, note and order-slot count here was read off a photograph of
 * the real paper form. Treat it as the source of truth and change it only
 * against a sheet you are looking at.
 */

export type FormId =
  | 'anamma'
  | 'chop_engomi'
  | 'chop_pindarou'
  | 'chop_cyprus'
  | 'chop_lakatamia'
  | 'china_spice';

export type LedgerRow =
  | { kind: 'input'; key: string; label: string; prefix?: string; sign?: '−';
      slots?: number; items?: 'cheques' | 'pending'; note?: string;
      editableLabel?: true; emphasis?: 'large'; retired?: true;
      /** Where the figure is copied from, shown in the empty box. */
      source?: 'z_report' }
  /**
   * A total with its parts underneath — FOODY ΟΛΙΚΟ over Bamboo and
   * Chopsticks, which are two separate Foody accounts at one branch.
   *
   * The GROUP is what gets deducted, exactly once, and its figure is the
   * sum of the children. The children are the only boxes anyone types
   * in. Deducting the children as well would take Foody off the day's
   * takings twice and leave every night short by the Foody amount.
   */
  | { kind: 'group'; key: string; label: string; sign?: '−';
      children: Array<{ key: string; label: string; retired?: true }>; retired?: true;
      /**
       * The row the parts stand in for, where there is one. The card
       * brackets (src/lib/cardMachines.ts) are the parts of SIX CARDS, so
       * the Sofia export posts their sum as the one SIX CARDS line it has
       * always posted. A group without it exports each part on its own.
       */
      countsAs?: string }
  | { kind: 'subtotal'; key: string; label: string }
  | { kind: 'expenses'; key: 'expenses'; label: string };

export interface LedgerForm {
  id: FormId;
  layout: 'ledger';
  displayName: string;          // what the restaurant picker shows
  legalName: string;
  tagline?: string;
  branch?: string;
  address: string;
  phone: string;
  formRef: string;
  pageNumber?: string;
  labelAlign: 'center' | 'right';
  cashLabel: string;
  expensesHeading: string;
  expenseColumns: [string, string];
  expenseRowCount: number;
  rows: LedgerRow[];
  /**
   * Named extra lines, as the shifts sheet has. These sheets print ONE
   * write-in row (staff put "Kiosk" in it); this continues that row into
   * a list that grows as it is filled.
   */
  allowCustomLines?: true;
  /**
   * The row key the named lines sit under — and, just as importantly,
   * the point in the deduction order where they come off.
   *
   * It is spelt out rather than inferred from the write-in row, because
   * Anamma has no write-in row and its named lines still have to land
   * before the T O T A L subtotal. A named line deducted after that
   * subtotal would not be in it, and the sheet would say the till holds
   * money that was never there.
   */
  customLinesAfter?: string;
  /**
   * The card row the manager can split into numbered brackets, one per
   * card machine used that night. See src/lib/cardMachines.ts.
   */
  cardRowKey?: string;
}

export interface ShiftsForm {
  id: FormId;
  layout: 'shifts';
  displayName: string;
  legalName: string;
  tagline?: string;
  address: string;
  phone: string;
  shifts: [string, string, string];
  tameioRows: Array<{ key: 'dineIn' | 'ta' | 'total'; label: string }>;
  /**
   * `retired` keeps a method that is no longer used OUT of new sheets
   * while leaving it in the config — which is what makes the figures
   * already saved under it keep coming back. Deleting the entry instead
   * would strand that money: the read-back path rebuilds a night from
   * this list, so a missing key returns nothing and the next correction
   * saves the night without it.
   */
  methods: Array<{ key: string; label: string; isCash?: true;
    visaBracket?: 'start' | 'end' | 'only'; retired?: true;
    /** A card bracket: one part of this row, which the sheet shows as
     *  their sum and the Sofia export posts as one line. */
    countsAs?: string }>;
  /**
   * Lets the manager name extra rows at the foot of the method block —
   * the blank line the China Spice sheet has printed under SKASH, which
   * gets "ΝΙΜΑ" or a platform name written on it by hand.
   *
   * They count as non-cash, like every other row in that block: the
   * money arrived through a channel, so it is subtracted from TOTAL to
   * say what cash should be in the till. A line that IS cash would have
   * to be configured as a method, not typed in here.
   */
  allowCustomLines?: true;
  /** As on LedgerForm: the card row the card brackets split. */
  cardRowKey?: string;
}

export type ZetForm = LedgerForm | ShiftsForm;

const NOTE_CHEQUE =
  '(Εκδίδονται στο όνομα C.A. China Spice Restaurants LTD. & απαραίτητα να σημειώνεται ' +
  'με καθαρά γράμματα στο πίσω μέρος της επιταγής, το όνομα & τηλέφωνο του πελάτη)';

const NOTE_PENDING =
  'Οργανισμοί/Εταιρείες που έχουμε συμφωνία για αποπληρωμή σε μεταγενέστερο στάδιο. ' +
  'Να γράφετε πάνω στην απόδειξη: Όνομα Οργανισμού/Εταιρείας (πχ ΚΟΤ, Δήμος Λ/σίας, ' +
  'όνομα Ταξ. Γραφείου), Άτομο Επαφής, τηλέφωνο και υπογραφή.';

export const ANAMMA: LedgerForm = {
  id: 'anamma',
  layout: 'ledger',
  displayName: 'ΤΟ ΑΝΑΜΜΑ · Λήδρας 87',
  legalName: 'ΤΟ ΑΝΑΜΜΑ',
  tagline: 'ΠΑΡΑΔΟΣΙΑΚΗ ΤΑΒΕΡΝΑ',
  address: 'Λήδρας 87, Λευκωσία',
  phone: '22210200',
  formRef: 'ΕΝΤΥΠΟ Τ ΑΝΑΜΜΑ-01_ΧΑ/γμ',
  pageNumber: '2',
  labelAlign: 'center',
  cashLabel: 'ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ €',
  expensesHeading: '* ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ -> ΑΠΟΔΕΙΞΕΙΣ & ΔΙΑΦΟΡΑ',
  expenseColumns: ['ΠΕΡΙΓΡΑΦΗ ΕΞΟΔΩΝ', 'ΠΟΣΟ €'],
  expenseRowCount: 14,
  rows: [
    { kind: 'input', key: 'gross', label: 'DAILY REPORT TOTAL', emphasis: 'large', source: 'z_report' },
    // VISA CARD 1 was the JCC terminal — the prefix printed on the paper
    // says so. JCC is gone company-wide, so the row is retired rather
    // than deleted: the nights already filed under it still show it.
    { kind: 'input', key: 'card1', label: 'VISA CARD 1', prefix: '(jcc smart-EUR€)', sign: '−', retired: true },
    // The one card row left. Renamed to match what the company actually
    // uses; the KEY stays card2, so every figure filed under it keeps
    // coming back.
    { kind: 'input', key: 'card2', label: 'SIX CARDS', sign: '−' },
    { kind: 'subtotal', key: 'afterCards', label: 'TOTAL' },
    { kind: 'input', key: 'FOODY', label: 'FOODY ΟΛΙΚΟ', sign: '−', slots: 5 },
    // Five, α–ε, on Arbab's instruction — the config had six (α–ζ).
    // Anything already filed in the sixth is no longer shown or posted,
    // so a corrected night will report its breakdown as not summing to
    // the row until someone re-enters it. Visible, not silent.
    { kind: 'input', key: 'B3', label: 'B3', sign: '−', slots: 5 },
    { kind: 'input', key: 'WOLT', label: 'WOLT ΟΛΙΚΟ', sign: '−', slots: 5 },
    { kind: 'input', key: 'BOLT', label: 'BOLT ΟΛΙΚΟ', sign: '−', slots: 5 },
    { kind: 'input', key: 'cheques', label: 'ΕΠΙΤΑΓΕΣ', sign: '−', items: 'cheques', note: NOTE_CHEQUE },
    { kind: 'input', key: 'pending', label: 'ΑΠΟΔΕΙΞΕΙΣ ΠΟΥ ΕΚΚΡΕΜΟΥΝ ΠΛΗΡΩΜΗΣ', sign: '−', items: 'pending', note: NOTE_PENDING },
    { kind: 'subtotal', key: 'cashSales', label: 'T O T A L' },
    { kind: 'expenses', key: 'expenses', label: '* ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ' },
  ],
  // B3 stays on this sheet: it is the one branch still using it.
  allowCustomLines: true,
  // No write-in row on this sheet, so the named lines hang off the last
  // deduction before T O T A L.
  customLinesAfter: 'pending',
  cardRowKey: 'card2',
};

/**
 * Engomi and Pindarou printed the same sheet until the two branches
 * diverged: Engomi has a self-order Visa kiosk, Pindarou runs two
 * separate Foody accounts. They were one shared array, so every change
 * meant for one branch silently landed on the other as well.
 *
 * `retired: true` marks a row the company has stopped using. It stays in
 * this list ON PURPOSE — the read-back path rebuilds a saved night from
 * these rows, so deleting an entry strands the money already recorded
 * under it and the next correction writes the night without it.
 */
const chopsticksCommonTail: LedgerRow[] = [
  { kind: 'input', key: 'WOLT', label: 'WOLT', sign: '−' },
  { kind: 'input', key: 'BOLT', label: 'BOLT', sign: '−' },
  // The printed sheet's one unlabelled row. Superseded by the named-line
  // list, which does the same job without a ceiling of one — so it is
  // retired: hidden on a fresh sheet, and still shown on a night that was
  // filed under it, which is most of the nights filed so far.
  { kind: 'input', key: 'other1', label: '', sign: '−', editableLabel: true, retired: true },
  { kind: 'input', key: 'cheques', label: 'ΕΠΙΤΑΓΕΣ ΠΕΛΑΤΩΝ', sign: '−', items: 'cheques', note: NOTE_CHEQUE },
  { kind: 'expenses', key: 'expenses', label: '* ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ' },
];

const engomiRows: LedgerRow[] = [
  { kind: 'input', key: 'gross', label: 'DAILY REPORT TOTAL', emphasis: 'large', source: 'z_report' },
  { kind: 'input', key: 'card1', label: 'JCC VISA CARD 1', sign: '−', retired: true },
  { kind: 'input', key: 'card2', label: 'SIX CARDS', sign: '−' },
  // Self-order machines in the mall. Card takings like any other Visa
  // row, so it is deducted to leave the cash the envelope should hold.
  { kind: 'input', key: 'kiosk', label: 'VISA KIOSK', sign: '−' },
  { kind: 'input', key: 'FOODY', label: 'FOODY', sign: '−' },
  { kind: 'input', key: 'B3', label: 'B3', sign: '−', retired: true },
  ...chopsticksCommonTail,
];

const pindarouRows: LedgerRow[] = [
  { kind: 'input', key: 'gross', label: 'DAILY REPORT TOTAL', emphasis: 'large', source: 'z_report' },
  { kind: 'input', key: 'card1', label: 'JCC VISA CARD 1', sign: '−', retired: true },
  { kind: 'input', key: 'card2', label: 'SIX CARDS', sign: '−' },
  // Every night already filed at this branch has its Foody money stored
  // under the key FOODY. Reusing that key for the GROUP would have hidden
  // those figures — the group reads its children, not itself — and the
  // next correction would have saved the night without them. It stays as
  // a retired row so an old night still shows what it held; the split
  // below is a new key.
  { kind: 'input', key: 'FOODY', label: 'FOODY', sign: '−', retired: true },
  // Two Foody accounts at this branch. The total is derived from the two
  // and is what gets deducted — exactly once. See computeLedger.
  {
    kind: 'group',
    key: 'FOODY_TOTAL',
    label: 'FOODY ΟΛΙΚΟ',
    sign: '−',
    children: [
      { key: 'FOODY_BAMBOO', label: 'Bamboo' },
      { key: 'FOODY_CHOPSTICKS', label: 'Chopsticks' },
    ],
  },
  { kind: 'input', key: 'B3', label: 'B3', sign: '−', retired: true },
  ...chopsticksCommonTail,
];

export const CHOPSTICKS_ENGOMI: LedgerForm = {
  id: 'chop_engomi',
  layout: 'ledger',
  displayName: 'CHOPSTICKS · Mall of Engomi',
  legalName: 'CHOPSTICKS',
  tagline: 'QUICK SERVICE ORIENTAL RESTAURANTS',
  branch: 'Chopsticks — Engomi',
  address: 'Shop 27, Mall of Engomi, 7-9 28th October, 2414 Λευκωσία',
  phone: '22832283',
  formRef: 'ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ',
  pageNumber: '1',
  labelAlign: 'right',
  cashLabel: 'ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ €',
  expensesHeading: '* ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ - ΑΠΟΔΕΙΞΕΙΣ & ΔΙΑΦΟΡΑ',
  expenseColumns: ['ΠΕΡΙΓΡΑΦΗ', 'ΠΟΣΟ €'],
  expenseRowCount: 14,
  rows: engomiRows,
  allowCustomLines: true,
  customLinesAfter: 'other1',
  cardRowKey: 'card2',
};

export const CHOPSTICKS_PINDAROU: LedgerForm = {
  ...CHOPSTICKS_ENGOMI,
  id: 'chop_pindarou',
  displayName: 'CHOPSTICKS · Πινδάρου 26',
  branch: 'Chopsticks @ Pindarou',
  address: 'Πινδάρου 26, 1060 Λευκωσία',
  phone: '22451111',
  // Spelt out, not inherited. This form spreads Engomi's, so anything
  // added there arrives here unannounced — which is how the Visa kiosk,
  // a machine that exists only in the mall, would have appeared on the
  // Pindarou sheet. The two branches keep their own rows.
  rows: pindarouRows,
  allowCustomLines: true,
  customLinesAfter: 'other1',
};

/**
 * The newest branch. Same printed sheet as Mall of Engomi, including the
 * self-order Visa kiosk, with its own letterhead.
 *
 * Named from Foody's own invoice — «Τίτλος: Chopsticks Mall of Cyprus»,
 * «Mall of Cyprus, Verginas 3, Strovolos 2030» — which also matches the
 * Todoist note. It was briefly built as Mall of Latsia. The name has to
 * be the one on the platform statements, because that is what a payout
 * gets matched against.
 *
 * Its rows are Engomi's by reference rather than by spreading the whole
 * form: spreading is what let the kiosk nearly land on Pindarou. If this
 * branch ever diverges, give it its own array here.
 */
export const CHOPSTICKS_MALL_OF_CYPRUS: LedgerForm = {
  ...CHOPSTICKS_ENGOMI,
  id: 'chop_cyprus',
  displayName: 'CHOPSTICKS · Mall of Cyprus',
  branch: 'Chopsticks — Mall of Cyprus',
  address: 'Mall of Cyprus, Verginas 3, Strovolos 2030, Λευκωσία',
  phone: '22570707',
  rows: engomiRows,
};

/**
 * Opened 07/10/2026. Engomi's sheet without the VISA KIOSK row: the
 * kiosk is a mall machine and this branch has none. Its own array, not
 * Engomi's by reference, so a row added to the malls does not appear
 * here unannounced. Nothing has been filed here yet, so the kiosk is
 * simply absent rather than retired.
 */
const lakatamiaRows: LedgerRow[] = engomiRows.filter((r) => r.key !== 'kiosk');

export const CHOPSTICKS_LAKATAMIA: LedgerForm = {
  ...CHOPSTICKS_ENGOMI,
  id: 'chop_lakatamia',
  displayName: 'CHOPSTICKS · Lakatamia',
  branch: 'Chopsticks — Lakatamia',
  address: 'Arch. Makarios III Avenue, Λακατάμια',
  phone: '22454400',
  rows: lakatamiaRows,
};

export const CHINA_SPICE: ShiftsForm = {
  id: 'china_spice',
  layout: 'shifts',
  // Renamed 07/10/2026. The id stays china_spice: every night already
  // filed, its login and its Sofia tag hang off the id, not the name.
  displayName: 'CHINASPICE@MONTPARNASSE',
  legalName: 'CHINASPICE MONTPARNASSE',
  tagline: 'RESTAURANT',
  address: 'Akropoleos 1',
  phone: '22875875',
  shifts: ['ΜΕΣΗΜΕΡΙ', 'ΒΡΑΔΥ', 'ΒΡΑΔΥ'],
  tameioRows: [
    { key: 'dineIn', label: 'Dine in:' },
    { key: 'ta', label: 'T/A:' },
    { key: 'total', label: 'Total:' },
  ],
  methods: [
    { key: 'CASH', label: 'CASH', isCash: true },
    // Retired, not deleted — the money saved under these keys has to keep
    // coming back when an old night is opened. JCC is gone company-wide;
    // B3, STRIPE and SKASH are unused here (B3 stays on the Anamma sheet).
    { key: 'JCC', label: 'J C C', retired: true },
    // Was "G A P". The key is unchanged on purpose: renaming it would
    // orphan every figure already filed under GAP. Only the printed name
    // changes, matching "SIX VISA CARD 2" on the Chopsticks sheets.
    { key: 'GAP', label: 'SIX CARDS', visaBracket: 'only' },
    { key: 'FOODY', label: 'FOODY' },
    { key: 'B3', label: 'B3', retired: true },
    { key: 'STRIPE', label: 'STRIPE', retired: true },
    { key: 'WOLT', label: 'WOLT' },
    { key: 'BOLT', label: 'BOLT' },
    { key: 'SKASH', label: 'SKASH', retired: true },
  ],
  // The printed sheet's spare line. It used to be a method called OTHER
  // with an empty label, which rendered the blank row but gave the
  // manager nowhere to write what the money was.
  allowCustomLines: true,
  cardRowKey: 'GAP',
};

/**
 * What to call a stored row when showing it to a person.
 *
 * The archive printed `row_key` straight out of the database, so the
 * accountant read "gross", "card1", "cheques" — and after the Foody
 * split, "FOODY_BAMBOO". Some keys happen to look like words (FOODY,
 * WOLT, BOLT), which is most likely why it went unnoticed.
 *
 * Order matters. A hand-written label wins: it is what the person
 * actually wrote on the sheet, and no config knows it. Then the printed
 * label from the config, which is what the paper says. The raw key last,
 * so an old row whose config entry is long gone still shows as
 * something rather than disappearing.
 */
export function rowLabelFor(
  form: ZetForm,
  rowKey: string,
  labelOverride?: string | null
): string {
  const written = (labelOverride ?? '').trim();
  if (written !== '') return written;

  if (form.layout === 'shifts') {
    const m = form.methods.find((x) => x.key === rowKey);
    // A card bracket is named with the row it is part of, as a group's
    // part is below: "1" alone on a page of totals does not say it
    // is card money.
    const parent = m?.countsAs ? form.methods.find((x) => x.key === m.countsAs) : undefined;
    if (m && parent) return `${parent.label} — ${m.label}`;
    return m?.label?.trim() || rowKey;
  }

  for (const row of form.rows) {
    if (row.key === rowKey && row.kind !== 'expenses') {
      return row.label.trim() || rowKey;
    }
    if (row.kind === 'group') {
      const child = row.children.find((c) => c.key === rowKey);
      // Named as part of its parent, because "Bamboo" alone on a page of
      // totals does not say which total it is part of.
      if (child) return `${row.label} — ${child.label}`;
    }
  }
  return rowKey;
}

/**
 * Where a stored row sits on the printed sheet, for putting a saved
 * night back in the order it was filled in.
 *
 * The archive listed rows by whatever order the query returned, which
 * was alphabetical by row_key: B3, BOLT, card1, card2, cheques, FOODY,
 * gross. While the page printed those keys it merely looked sorted.
 * Named properly, it reads as shuffled — DAILY REPORT TOTAL seventh, in
 * the middle of its own deductions.
 *
 * Anything the config does not know sorts to the end rather than the
 * front, so a retired or long-deleted row never displaces the figures
 * the sheet is actually about.
 */
export function rowOrderFor(form: ZetForm, rowKey: string): number {
  if (form.layout === 'shifts') {
    const i = form.methods.findIndex((m) => m.key === rowKey);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }
  let n = 0;
  for (const row of form.rows) {
    if (row.key === rowKey) return n;
    n += 1;
    if (row.kind === 'group') {
      for (const child of row.children) {
        if (child.key === rowKey) return n;
        n += 1;
      }
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

export const FORMS: Record<FormId, ZetForm> = {
  anamma: ANAMMA,
  chop_engomi: CHOPSTICKS_ENGOMI,
  chop_pindarou: CHOPSTICKS_PINDAROU,
  chop_cyprus: CHOPSTICKS_MALL_OF_CYPRUS,
  chop_lakatamia: CHOPSTICKS_LAKATAMIA,
  china_spice: CHINA_SPICE,
};

export const FORM_ORDER: FormId[] = [
  'anamma',
  'chop_engomi',
  'chop_pindarou',
  'chop_cyprus',
  'chop_lakatamia',
  'china_spice',
];
