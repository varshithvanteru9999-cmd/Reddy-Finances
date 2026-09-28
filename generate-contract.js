const PDFDocument = require('pdfkit');
const fs = require('fs');

const doc = new PDFDocument({ margin: 60, size: 'LETTER' });
doc.pipe(fs.createWriteStream('Rental-Contract-Template.pdf'));

const primaryColor = '#1a1a2e';
const accentColor = '#c0392b';
const lightGray = '#f5f5f5';
const darkGray = '#4a4a4a';

const pageWidth = doc.page.width - 120;
let y = 60;

// Helper functions
const addText = (text, options = {}) => {
  const { bold = false, size = 11, color = primaryColor, align = 'left', indent = 0, marginBottom = 6, underline = false } = options;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const x = 60 + indent;
  const width = pageWidth - indent;
  if (align === 'center') {
    doc.text(text, x, y, { width, align: 'center' });
  } else {
    doc.text(text, x, y, { width });
  }
  const height = doc.heightOfString(text, { width });
  y += height + marginBottom;
};

const addSpacer = (height = 12) => { y += height; };

const addLine = (color = '#ddd', thickness = 1) => {
  doc.strokeColor(color).lineWidth(thickness).moveTo(60, y).lineTo(doc.page.width - 60, y).stroke();
  y += 10;
};

const addBullet = (number, text, options = {}) => {
  const { bold = false, size = 10, indent = 80, marginBottom = 8, highlight = false } = options;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(highlight ? accentColor : darkGray);
  const x = indent;
  const width = pageWidth - indent + 60;
  doc.text(`${number}. ${text}`, x, y, { width });
  const height = doc.heightOfString(`${number}. ${text}`, { width });
  y += height + marginBottom;
};

const addHighlightBox = (text, options = {}) => {
  const { size = 10, marginBottom = 12, bgColor = '#fff3cd', borderColor = accentColor } = options;
  doc.font('Helvetica-Bold').fontSize(size).fillColor(primaryColor);
  const padding = 10;
  const textWidth = pageWidth - 40;
  const textHeight = doc.heightOfString(text, { width: textWidth - padding * 2 });
  const boxHeight = textHeight + padding * 2;
  
  // Background
  doc.rect(80, y, pageWidth - 40, boxHeight).fill(bgColor);
  // Border
  doc.rect(80, y, pageWidth - 40, boxHeight).stroke(borderColor);
  // Text
  doc.fillColor(primaryColor).text(text, 80 + padding, y + padding, { width: textWidth - padding * 2 });
  y += boxHeight + marginBottom;
};

const checkPageBreak = (needed = 100) => {
  if (y + needed > doc.page.height - 60) {
    doc.addPage();
    y = 60;
  }
};

// ===== HEADER =====
doc.rect(60, y, pageWidth, 60).fill(primaryColor);
doc.fillColor('#fff').font('Helvetica-Bold').fontSize(22).text('VEHICLE RENTAL AGREEMENT', 60, y + 12, { width: pageWidth, align: 'center' });
doc.font('Helvetica').fontSize(11).text('Monthly Rental Contract Template', 60, y + 40, { width: pageWidth, align: 'center' });
y += 80;

// ===== KEY TERMS SUMMARY =====
addText('KEY TERMS AT A GLANCE', { bold: true, size: 13, color: accentColor, marginBottom: 10 });

const keyTerms = [
  { label: 'Advance Payment', value: '1 Month Advance + First Month Rent due at pickup' },
  { label: 'Payment Methods', value: 'Zelle or Cash (Credit cards: 3% fee)' },
  { label: 'Minimum Term', value: '1 Month (no prorated refunds for early return)' },
  { label: 'Late Fee', value: '$10/day after due date' },
  { label: 'Late Return', value: '$45/day charged from deposit' },
  { label: 'Refund Timeline', value: 'Deposit refunded 2 weeks after return' },
  { label: 'Insurance', value: 'Proof required within 24 hours (Full coverage recommended)' },
  { label: 'Toll Tag', value: 'Required — $25 charge if owner pays ZipCash' },
  { label: 'Maintenance', value: 'Oil changes every 3,000 mi (5,000 mi synthetic) — receipts required' },
  { label: 'Notice to Return', value: '2 weeks written notice required' },
  { label: 'Business Hours', value: 'Mon–Sat 9 AM – 7 PM (emergencies anytime)' },
];

keyTerms.forEach(({ label, value }) => {
  checkPageBreak(30);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text(label, 80, y, { width: 180 });
  doc.font('Helvetica').fontSize(10).fillColor(darkGray).text(value, 260, y, { width: pageWidth - 260 });
  const h1 = doc.heightOfString(label, { width: 180 });
  const h2 = doc.heightOfString(value, { width: pageWidth - 260 });
  y += Math.max(h1, h2) + 6;
});

addSpacer(8);
addLine(accentColor, 2);
addSpacer(10);

// ===== IMPORTANT NOTICES =====
addText('⚠  CRITICAL REMINDERS', { bold: true, size: 13, color: accentColor, marginBottom: 10 });

addHighlightBox('📹  TAKE VIDEOS/PHOTOS OF ALL EXISTING DAMAGE AT PICKUP — You are responsible for any new damage not documented.', { bgColor: '#fef3e2', borderColor: '#e67e22' });
addHighlightBox('🛡  PROOF OF INSURANCE MUST BE SUBMITTED WITHIN 24 HOURS — Full coverage strongly recommended.', { bgColor: '#fef3e2', borderColor: '#e67e22' });
addHighlightBox('⛽  RETURN VEHICLE CLEAN, SAME FUEL LEVEL, TOLLS PAID — By 6 PM on return date.', { bgColor: '#fef3e2', borderColor: '#e67e22' });
addHighlightBox('🔧  OIL CHANGES EVERY 3,000 MI (5,000 MI SYNTHETIC) — SEND RECEIPT PHOTOS. Engine damage from missed changes = renter\'s cost.', { bgColor: '#fef3e2', borderColor: '#e67e22' });
addHighlightBox('💳  ZELLE PAYMENTS TO: [PHONE NUMBER]  |  ACCOUNT: [ACCOUNT NAME]  |  NOTE: INCLUDE VEHICLE #', { bgColor: '#e8f5e9', borderColor: '#27ae60' });

addSpacer(10);
addLine('#ddd');
addSpacer(10);

// ===== TERMS & CONDITIONS =====
addText('TERMS & CONDITIONS', { bold: true, size: 13, color: primaryColor, marginBottom: 10 });

const terms = [
  { num: 1, text: 'Advance payment is fully refundable 2 weeks after vehicle return, provided no damages, tolls, or fees are outstanding.', highlight: false },
  { num: 2, text: 'Vehicle must be returned clean by 6 PM on the lease end date with the same fuel level as pickup. All tolls (NTTA.org, ZipCash) must be paid in full.', highlight: false },
  { num: 3, text: 'Late return: $45 per day charged from deposit. No exceptions.', highlight: true },
  { num: 4, text: 'This is a monthly agreement. No prorated refunds for early return. 1-month minimum term.', highlight: true },
  { num: 5, text: 'Proof of insurance must be sent within 24 hours of pickup. The owner does not provide insurance.', highlight: true },
  { num: 6, text: 'Toll tag must be on vehicle. If owner pays ZipCash bill, a $25 administrative fee applies.', highlight: false },
  { num: 7, text: 'Payments due on the original pickup date each month. $10 late fee per day for overdue payments.', highlight: true },
  { num: 8, text: 'Driver is responsible for flat tires, oil changes, and parts replacement due to negligence.', highlight: false },
  { num: 9, text: 'Oil changes required every 3,000 miles (5,000 miles with synthetic oil). Receipt photos must be sent after each service. Engine damage from missed oil changes is the driver\'s financial responsibility.', highlight: true },
  { num: 10, text: 'If repair is needed, bring the vehicle in. If towing is required, driver covers the cost.', highlight: false },
  { num: 11, text: 'Vehicle switches allowed if another car is available — insurance must be transferred to the new vehicle.', highlight: false },
  { num: 12, text: 'At-fault accidents without full coverage insurance: driver is responsible for all repair costs not covered by insurance.', highlight: true },
  { num: 13, text: 'Provide 2 weeks\' written notice before returning vehicle. Confirm zero toll balance at that time.', highlight: false },
  { num: 14, text: 'If vehicle overheats — DO NOT DRIVE. Call immediately. Any abnormal noise — stop and inspect.', highlight: true },
  { num: 15, text: 'Business hours: Monday–Saturday, 9 AM – 7 PM. Message during these hours unless it\'s an emergency.', highlight: false },
  { num: 16, text: 'Zelle payments to: [PHONE NUMBER] | Account: [ACCOUNT NAME] | Include vehicle number in notes.', highlight: false },
];

terms.forEach(({ num, text, highlight }) => {
  checkPageBreak(50);
  addBullet(num, text, { highlight, size: 10, marginBottom: 9 });
});

addSpacer(20);
addLine(accentColor, 2);
addSpacer(20);

// ===== SIGNATURE BLOCK =====
addText('AGREEMENT & SIGNATURE', { bold: true, size: 13, color: primaryColor, marginBottom: 15 });

addText('By signing below, I acknowledge that I have read, understood, and agree to all terms and conditions of this rental agreement.', { size: 10, color: darkGray, marginBottom: 25 });

// Signature lines
const sigY = y;
doc.strokeColor('#999').lineWidth(1);

// Full Name
doc.moveTo(80, sigY).lineTo(320, sigY).stroke();
doc.font('Helvetica').fontSize(9).fillColor('#999').text('Full Name', 80, sigY + 4);

// Signature
doc.moveTo(360, sigY).lineTo(520, sigY).stroke();
doc.text('Signature', 360, sigY + 4);

// Date
doc.moveTo(540, sigY).lineTo(doc.page.width - 60, sigY).stroke();
doc.text('Date', 540, sigY + 4);

y = sigY + 30;

// Witness line (optional)
doc.moveTo(80, y).lineTo(320, y).stroke();
doc.font('Helvetica').fontSize(9).fillColor('#999').text('Owner/Authorized Representative Signature', 80, y + 4);

y += 40;

// Footer
doc.font('Helvetica-Oblique').fontSize(8).fillColor('#999').text(
  'This is a template rental agreement. Customize all bracketed fields [ ] before use. Consult local laws for compliance.',
  60, doc.page.height - 60, { width: pageWidth, align: 'center' }
);

doc.end();
console.log('PDF generated: Rental-Contract-Template.pdf');