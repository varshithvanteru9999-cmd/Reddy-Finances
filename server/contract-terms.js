/* ------------------------------------------------------------------
   The rental agreement's wording, kept apart from the PDF drawing so
   the text can be corrected without touching layout code.

   This is the "Monthly Vehicle Rental Agreement" supplied by the
   office. It is organised as nine titled sections rather than the flat
   numbered list used before, because that is how the document reads and
   how a renter is likely to refer to it ("clause 5, tolls").

   Wording is reproduced as supplied. Anything the app states elsewhere
   — the deposit being refundable after two weeks, tolls billed
   separately — is phrased here the same way, so an invoice and the
   agreement can never be read against each other.
------------------------------------------------------------------- */

const COMPANY = 'Reddy Financial';
const COMPANY_TAGLINE = 'VEHICLE LEASING & RENTAL SERVICES';
const CONTACT_EMAIL = 'reddyfinancialsinc@gmail.com';
const BUSINESS_HOURS = 'Mon-Sat, 9:00 AM - 7:00 PM';

const TITLE = 'MONTHLY VEHICLE RENTAL AGREEMENT';

const INTRO =
  `This Agreement is entered into between ${COMPANY} (the "Company") and the ` +
  'individual identified below (the "Driver") for the monthly rental of the ' +
  'vehicle described herein. By signing this Agreement, the Driver accepts ' +
  'each of the terms set out below.';

/* The detail table at the head of the document. `key` is looked up on
   the booking; a missing value prints as a blank line to be filled in
   by hand, which is how the paper form behaves. */
/* The period rows sit directly under the pickup line. The agreement
   previously named only a pickup date, so the term it covered was
   nowhere on the document a renter signs — and clause 2 charges $45 a
   day for a late return against a date the paper never stated.

   This is a monthly agreement that renews, so each month gets its own
   dated copy: RENTAL PERIOD names the month and the two date fields
   bound it. */
const DETAIL_FIELDS = [
  [['DRIVER NAME', 'driverName'], ['VEHICLE / CAR NO.', 'vehicle']],
  [['PICKUP DATE & TIME', 'pickup'], ['MONTHLY RENT', 'monthlyRent']],
  [['RENTAL PERIOD', 'periodLabel'], ['AMOUNT FOR THIS PERIOD', 'periodAmount']],
  [['PERIOD START DATE', 'startDate'], ['PERIOD END DATE', 'endDate']],
  [['DRIVING LICENCE NO.', 'licence'], ['PHONE NUMBER', 'phone']],
  [['EMAIL', 'email'], null],
  [['REFERRAL NAME', 'referralName'], ['REFERRAL PHONE', 'referralPhone']]
];

/* Each section is a heading and its paragraphs. Emphasis marks the
   phrases the office wants to carry weight on the page. */
const SECTIONS = [
  {
    heading: 'TERM AND PAYMENT',
    paragraphs: [
      'This is a monthly rental agreement with a one-month minimum. One full ' +
      "month's payment in advance, together with the first month's rent, is due " +
      'when the vehicle is picked up, and there are no exceptions to this ' +
      'requirement. Every month thereafter, payment must be received on or ' +
      'before the 5th of the month. Any payment received after the 5th carries ' +
      'a late fee of $50.',

      'Payments may be made by Zelle or in cash. Credit cards are accepted with ' +
      'a 3% processing fee added to the amount charged. If the vehicle is driven ' +
      'more than 3,500 miles, a charge of 0.1 cent is added for each mile above ' +
      'that figure. Because the agreement is monthly, rent is not prorated: a ' +
      'vehicle returned before the paid month ends earns no partial refund.'
    ]
  },
  {
    heading: 'SECURITY DEPOSIT',
    paragraphs: [
      'The one-month advance held at pickup serves as the security deposit and ' +
      'is fully refundable two weeks after the vehicle is returned. That waiting ' +
      'period allows any outstanding tolls, damage, or fees to be identified and ' +
      'settled before the refund is released.',

      'Amounts owed under this Agreement will be deducted from the deposit. If ' +
      'the vehicle is returned after the lease end date, a daily rental charge ' +
      'of $45 will be taken from the deposit for each late day, with no exceptions.'
    ]
  },
  {
    heading: 'VEHICLE CONDITION AND DAMAGE',
    paragraphs: [
      'Before driving away, the Driver should take videos of any damage already ' +
      "present on the vehicle. This footage is the Driver's own record and " +
      'protects both parties if a dispute later arises about when a mark appeared.',

      'When the vehicle is returned, the Driver is responsible for any new damage ' +
      'that was not marked at pickup. Damage caused by negligence, including the ' +
      "cost of parts, is also the Driver's responsibility."
    ]
  },
  {
    heading: 'INSURANCE',
    paragraphs: [
      'A picture of proof of insurance must be sent to the Company within 24 ' +
      'hours of picking up the vehicle. If the Driver is at fault in an accident ' +
      'and does not carry full coverage, the Driver is responsible for the cost ' +
      'of repairs to the extent insurance does not cover the damage.',

      'If the Company has another vehicle the Driver prefers, a switch may be ' +
      'arranged. Insurance must be transferred to the new vehicle before it is driven.'
    ]
  },
  {
    heading: 'TOLLS',
    paragraphs: [
      "All tolls incurred while the vehicle is in the Driver's possession are the " +
      "Driver's responsibility and must be paid in full at NTTA.ORG or through " +
      'Pay Zip Cash. Tolls charged to the Company will be passed on to the Driver ' +
      'and sent in the invoice for the first month.',

      'Before returning the vehicle, the Driver must confirm that no tolls remain ' +
      'owed. Outstanding toll amounts will be deducted from the deposit.'
    ]
  },
  {
    heading: 'MAINTENANCE AND REPAIRS',
    paragraphs: [
      'General maintenance and oil changes are included in the rental payment, ' +
      "provided the vehicle is brought to the Company's address for the work to " +
      'be carried out. If the Driver waives this and has the work done elsewhere, ' +
      "the cost is the Driver's own, and a picture of the receipt must be sent to " +
      'the Company each time.',

      'Either way, oil must be changed every 3,000 miles, or every 5,000 miles if ' +
      'synthetic oil is used. If the engine is damaged because oil changes were ' +
      'not made on time, the Driver is responsible for the cost of repairs. The ' +
      'Driver also remains responsible for flat tires and for the cost of any ' +
      'parts needed as a result of negligence.',

      'When a repair is needed, the vehicle must be brought in to the Company. If ' +
      'a tow is required, the Driver covers the cost of the tow. If the vehicle ' +
      'overheats, the Driver must not drive it - stop and call immediately. Any ' +
      'abnormal noise should be reported and the vehicle brought by for a check ' +
      'rather than driven on.'
    ]
  },
  {
    heading: 'RETURNING THE VEHICLE',
    paragraphs: [
      "The Driver must give two weeks' notice before returning the vehicle so the " +
      'handover can be arranged. On the final day of the lease the vehicle must ' +
      'be dropped off by 6:00 PM, cleaned, and with the same amount of fuel it ' +
      'had at pickup. Tolls should be confirmed paid in full before drop-off.',

      'A vehicle returned after that deadline is charged $45 per day against the ' +
      'deposit. Returning early does not reduce the amount owed, since the ' +
      'Agreement runs by the month and is not prorated.'
    ]
  },
  {
    heading: 'CONTACT AND BUSINESS HOURS',
    paragraphs: [
      'Business hours are Monday through Saturday, 9:00 AM to 7:00 PM. Messages ' +
      'should be sent during these hours unless the matter is an emergency, in ' +
      'which case the Driver may call at any time.',

      `Zelle payments go to ${CONTACT_EMAIL} under the account name ${COMPANY}. ` +
      'The Driver must put the car number in the notes field of every payment so ' +
      'it can be matched to the correct account.'
    ]
  },
  {
    heading: 'NON-PAYMENT AND NON-RESPONSE',
    paragraphs: [
      'Payment and communication are conditions of keeping the vehicle. If a ' +
      'payment becomes overdue and the Driver does not respond to the ' +
      "Company's attempts to make contact, the Company will treat the continued " +
      'possession of the vehicle as unauthorized use and will report the vehicle ' +
      'to the police.',

      'Any balance still outstanding will additionally be referred to a collection ' +
      'agency for recovery. The Driver remains responsible for the full amount ' +
      'owed, along with any fees or costs arising from the referral and from ' +
      'recovery of the vehicle.'
    ]
  }
];

const ACKNOWLEDGEMENT =
  'By signing below, the Driver confirms having read and understood every term ' +
  'of this Agreement and accepts responsibility for the payments, maintenance, ' +
  'tolls, and damage obligations described above.';

const FOOTER = `${COMPANY} - ${CONTACT_EMAIL} - ${BUSINESS_HOURS}`;

module.exports = {
  COMPANY, COMPANY_TAGLINE, CONTACT_EMAIL, BUSINESS_HOURS,
  TITLE, INTRO, DETAIL_FIELDS, SECTIONS, ACKNOWLEDGEMENT, FOOTER
};
