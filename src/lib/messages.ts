/**
 * The Greek text SPEC.md §5 asks for: plain instructions, not descriptions
 * of a violation.
 *
 * This lives apart from src/server/saveReport.ts (which used to define
 * these inline) so a client component can show the same live list the
 * server would eventually return, without importing anything that drags in
 * `pg`. saveReport.ts's module graph reaches src/lib/db.ts, which opens a
 * real `pg` Pool at module load — fine on the server, fatal if a "use
 * client" component's bundle ever pulled it in (pg needs Node's `net`/`tls`,
 * neither of which exist in a browser). Framework-free, dependency-free: the
 * one property this module exists to keep.
 */

export const MSG_DATE = 'Βάλτε ημερομηνία.';
export const MSG_MANAGER = 'Γράψτε ποιος κλείνει το ταμείο.';
export const MSG_SIGNATURE = 'Βάλτε υπογραφή.';
export const MSG_ONLY_NUMBERS = 'Μόνο αριθμοί';
export const MSG_TOO_BIG = 'Πολύ μεγάλο ποσό — ελέγξτε το.';
export const MSG_CORRECTION_REASON = 'Γράψτε γιατί διορθώνετε το κλείσιμο.';
export const MSG_NOT_ALLOWED = 'Δεν έχετε δικαίωμα για αυτό το εστιατόριο.';
/** Approving is the admin's (decided 05/10/2026). */
export const MSG_ADMIN_REQUIRED = 'Τα κλεισίματα τα εγκρίνει μόνο ο διαχειριστής.';
/** An approved night is corrected by the admin only. */
export const MSG_APPROVED_ADMIN_ONLY =
  'Αυτό το κλείσιμο έχει εγκριθεί. Διορθώνεται μόνο από τον διαχειριστή.';
export const MSG_GENERIC = 'Δεν αποθηκεύτηκε — κάτι πήγε στραβά.';

/** "Δεν αποθηκεύτηκε — λείπουν 3 πράγματα" / "… λείπει 1 πράγμα" */
export function missingHeader(count: number): string {
  return count === 1
    ? 'Δεν αποθηκεύτηκε — λείπει 1 πράγμα'
    : `Δεν αποθηκεύτηκε — λείπουν ${count} πράγματα`;
}

// ── Receipt photos ────────────────────────────────────────────────────
// The object key includes the business date, so the date must exist before
// a photo can be filed anywhere sensible. Saying so beats failing quietly.
export const MSG_DATE_FIRST =
  'Συμπληρώστε την ημερομηνία του κλεισίματος πριν προσθέσετε φωτογραφία.';
export const MSG_PHOTO_FAILED = 'Η φωτογραφία δεν στάλθηκε. Δοκιμάστε ξανά.';

/* An iPhone photo in Apple's HEIC format, opened in a browser that cannot
   decode it. "Try again" is useless advice here — trying again does the
   same thing — so this says what to actually do instead. */
export const MSG_PHOTO_HEIC =
  'Αυτή η φωτογραφία είναι σε μορφή HEIC, που δεν διαβάζει αυτό το πρόγραμμα. ' +
  'Τραβήξτε την ξανά με το κουμπί της κάμερας, ή στο iPhone: ' +
  'Ρυθμίσεις → Κάμερα → Μορφές → «Πιο συμβατό».';
export const MSG_PHOTO_UPLOADING = 'Αποστολή…';
export const MSG_PHOTO_SCANNING = 'Διαβάζεται…';
/** Shown beside the thumbnail. The file name is in the tooltip. */
export const MSG_PHOTO_ATTACHED = 'Επισυνάφθηκε';
/** Shown when the scanner filled a field but was not sure of the amount. */
export const MSG_PHOTO_LOW_CONFIDENCE = 'Χαμηλή βεβαιότητα — ελέγξτε την απόδειξη';
/** Shown for EVERY amount read off a photo, however sure the model said it was. */
export const MSG_PHOTO_AMOUNT_CHECK = 'Το ποσό διαβάστηκε από τη φωτογραφία — ελέγξτε το';
/** The scan ran and could not supply some fields. Saying nothing is not an option. */
export const MSG_PHOTO_UNREAD_PREFIX = 'Δεν διαβάστηκαν από τη φωτογραφία:';
export const MSG_PHOTO_UNREAD_SUFFIX = '— συμπληρώστε τα με το χέρι';
/** Field names as they read inside that sentence, lower case. */
/* Named rows — the blank line the manager writes on. Refusing a line is
   always about the line, never "κάτι πήγε στραβά": the money is in
   front of them and they need to know which box to fix. */
export const MSG_LINE_NEEDS_NAME = 'Γράψτε όνομα στη γραμμή που έχει ποσό.';
export const MSG_LINE_DUPLICATE = 'Δύο γραμμές με το ίδιο όνομα — ενώστε τις.';
export const MSG_LINE_TOO_LONG = 'Πολύ μεγάλο όνομα γραμμής — συντομεύστε το.';

/* Scanned PDFs. One file can hold a whole day's receipts, so what
   happened to the OTHER pages is the thing a person needs told. */
export const MSG_PDF_SPREAD = (pages: number) =>
  `Το PDF είχε ${pages} σελίδες — μπήκαν σε ${pages} γραμμές.`;
export const MSG_PDF_TOO_MANY = (pages: number) =>
  `Το PDF έχει ${pages} σελίδες — πάρα πολλές. Χωρίστε το.`;
export const MSG_PDF_UNREADABLE = 'Το PDF δεν διαβάστηκε.';
/* Said when pages had to be dropped because there was nowhere to put
   them. Never silent: these are receipts. */
export const MSG_PDF_NO_ROOM = (attached: number, total: number) =>
  `Μπήκαν ${attached} από ${total} σελίδες — δεν υπήρχαν άλλες γραμμές. Βάλτε τις υπόλοιπες χειροκίνητα.`;

export const MSG_FIELD_NAME = 'όνομα';
export const MSG_FIELD_AMOUNT = 'ποσό';
export const MSG_FIELD_INVOICE_NO = 'αρ. τιμολογίου';
export const MSG_FIELD_DATE = 'ημερομηνία';
/** The tick that unblocks saving such a line. */
export const MSG_PHOTO_CONFIRM_CHECKED = 'Έλεγξα την απόδειξη';
/** Refusal shown when saving with an unchecked low-confidence line. */
export const MSG_PHOTO_CHECK_FIRST =
  'Ελέγξτε τις αποδείξεις με χαμηλή βεβαιότητα και σημειώστε τες πριν αποθηκεύσετε.';
export const MSG_SUPPLIER = 'Προμηθευτής';
/** Shown when an unfinished sheet is offered back after a reload. */
export const MSG_DRAFT_NO_PHOTOS =
  'Οι φωτογραφίες των αποδείξεων δεν κρατούνται. Θα χρειαστεί να τις ξαναβγάλετε και να υποβάλετε ξανά το έντυπο.';
export const MSG_INVOICE_NO = 'Αρ. τιμολογίου';
export const MSG_INVOICE_DATE = 'Ημ/νία απόδειξης';
export const MSG_INVOICE_DATE_BAD = 'Μη έγκυρη ημερομηνία — δεν θα αποθηκευτεί';
/** Shown beside an amount that came from a photo rather than a person. */
export const MSG_FROM_PHOTO = 'από τη φωτογραφία — ελέγξτε το';

/**
 * One message per way an upload can fail. The first version said only
 * "the photo was not sent" for all of them, which told nobody anything —
 * a bucket missing its browser-upload rule, an expired session and an
 * unreadable image all read the same.
 */
export const MSG_PHOTO_NOT_CONFIGURED = 'Οι φωτογραφίες δεν έχουν ρυθμιστεί σε αυτόν τον διακομιστή.';
export const MSG_PHOTO_NOT_ALLOWED = 'Η σύνδεσή σας έληξε. Συνδεθείτε ξανά.';
export const MSG_PHOTO_BLOCKED = 'Ο αποθηκευτικός χώρος απέρριψε τη σύνδεση (CORS). Δείτε docs/R2-CORS.md.';
export const MSG_PHOTO_REJECTED = 'Ο αποθηκευτικός χώρος απέρριψε τη φωτογραφία.';
export const MSG_PHOTO_UNREADABLE = 'Δεν διαβάζεται αυτή η φωτογραφία. Δοκιμάστε JPEG.';
/**
 * A camera RAW file (DNG from a phone's "RAW/ProRAW" mode, or a camera's
 * own format). No browser opens these, so "try again" would be wrong
 * advice — the file itself has to be a different kind.
 */
export const MSG_PHOTO_RAW =
  'Αυτό είναι αρχείο RAW (π.χ. DNG) και δεν ανοίγει στον browser. Χρησιμοποιήστε το κουμπί της κάμερας ή μια φωτογραφία JPEG.';

// ── Receipt items (src/lib/receiptItems.ts) ─────────────────────────────
export const MSG_ITEMS = 'Είδη';
export const MSG_ITEMS_ADD_FIRST = '+ Είδη απόδειξης';
export const MSG_ITEMS_ADD = '+ είδος';
export const MSG_ITEM_NAME = 'Είδος';
export const MSG_ITEM_QTY = 'Ποσότητα';
export const MSG_ITEM_AMOUNT = 'Ποσό';
export const MSG_ITEM_REMOVE = 'Αφαίρεση είδους';
export const MSG_ITEMS_TOTAL = 'Σύνολο ειδών';
/** Shown while the list is still as the scan read it. */
export const MSG_ITEMS_FROM_PHOTO = 'Διαβάστηκαν από τη φωτογραφία — διορθώστε ό,τι δεν ταιριάζει.';
export const MSG_ITEMS_COUNT = (n: number) => (n === 1 ? '1 είδος' : `${n} είδη`);
/**
 * Information, not an error: a discount, a deposit or one misread price
 * all produce this, and none of them should stop a save.
 */
export const MSG_ITEMS_DIFFERENCE = (items: string, line: string, difference: string) =>
  `Τα είδη δίνουν ${items}, το ποσό της απόδειξης είναι ${line} (διαφορά ${difference}).`;

/**
 * Inside the "who closed the till" box, so it reads as a place for a
 * person's name. A hint only — the label above the box still names it.
 */
export const MSG_MANAGER_NAME_PLACEHOLDER = 'Όνομα';
