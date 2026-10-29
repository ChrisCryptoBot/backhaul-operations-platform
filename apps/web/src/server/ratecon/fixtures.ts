/**
 * Canned readings of two fictional sample rate confirmations (TrueLane's content/demo-rate-cons: invented brokers
 * and shippers, 555 phone numbers, a SAMPLE DOCUMENT stamp). They are in the model's raw "zero-union" shape ("" for
 * not printed, money as text) so they go through the same normalizeExtraction a live reading does. They let the
 * intake flow run end to end with no API key.
 */
export const DEMO_RATE_CON_READINGS: Record<string, Record<string, unknown>> = {
  "RC-AFB-482913": {
    issuedDate: "2026-11-03",
    broker: { name: "Acme Freight Brokers", mcNumber: "", dotNumber: "", phone: "555-0142", email: "dispatch@example.com" },
    carrier: { name: "", mcNumber: "" },
    loadNumber: "AFB-482913",
    poNumber: "5521084",
    stops: [
      {
        type: "pickup",
        name: "Sample Shipper Dallas",
        address: "2300 Irving Blvd, Dallas, TX 75207",
        appointmentDate: "2026-11-10",
        appointmentTime: "09:00",
        appointmentType: "appointment",
        windowEndTime: "",
        referenceNumbers: ["PU-77410"],
        contactName: "",
        contactPhone: "555-0187",
        instructions: "Check in at the front office"
      },
      {
        type: "delivery",
        name: "Sample Receiver Houston",
        address: "6100 Navigation Blvd, Houston, TX 77011",
        appointmentDate: "2026-11-10",
        appointmentTime: "16:00",
        appointmentType: "appointment",
        windowEndTime: "",
        referenceNumbers: ["DL-3390"],
        contactName: "",
        contactPhone: "555-0166",
        instructions: ""
      }
    ],
    rate: { total: "800", lineHaul: "740", fuelSurcharge: "60", accessorials: [] },
    paymentTermsDays: "30",
    weightLbs: "",
    dimensions: { lengthFt: "", widthFt: "", heightIn: "" },
    commodity: "Palletized goods",
    equipment: "Cargo van / Sprinter",
    detentionTerms: "$45 per hour after 2 hours free. TONU $100.",
    notes: "",
    tonuOnly: false,
    warnings: [],
    milesPrinted: "242",
    paymentTermsText: "Net 30 (quick pay 3%)",
    detentionFreeMinutes: "120",
    detentionHourlyRate: "45"
  },
  "RC-RDL-77315": {
    issuedDate: "2026-11-05",
    broker: { name: "Redline Demo Logistics", mcNumber: "", dotNumber: "", phone: "555-0119", email: "ops@example.com" },
    carrier: { name: "", mcNumber: "" },
    loadNumber: "RDL-77315",
    poNumber: "",
    stops: [
      {
        type: "pickup",
        name: "Sample Shipper Fort Worth",
        address: "1200 Main St, Fort Worth, TX 76102",
        appointmentDate: "2026-11-12",
        appointmentTime: "07:00",
        appointmentType: "window",
        windowEndTime: "09:00",
        referenceNumbers: ["PU-55120"],
        contactName: "",
        contactPhone: "555-0151",
        instructions: ""
      },
      {
        type: "delivery",
        name: "Sample Receiver Waco",
        address: "400 Franklin Ave, Waco, TX 76701",
        appointmentDate: "2026-11-12",
        appointmentTime: "11:00",
        appointmentType: "window",
        windowEndTime: "13:00",
        referenceNumbers: ["DL-8841"],
        contactName: "",
        contactPhone: "555-0172",
        instructions: ""
      },
      {
        type: "delivery",
        name: "Sample Receiver Austin",
        address: "900 Congress Ave, Austin, TX 78701",
        appointmentDate: "2026-11-12",
        appointmentTime: "15:00",
        appointmentType: "appointment",
        windowEndTime: "",
        referenceNumbers: ["DL-8842"],
        contactName: "",
        contactPhone: "555-0133",
        instructions: "Dock 2"
      }
    ],
    rate: { total: "640", lineHaul: "575", fuelSurcharge: "65", accessorials: [] },
    paymentTermsDays: "21",
    weightLbs: "",
    dimensions: { lengthFt: "", widthFt: "", heightIn: "" },
    commodity: "Retail fixtures",
    equipment: "Box truck, 26 ft",
    detentionTerms: "$40 per hour after 2 hours free, per stop. TONU $125.",
    notes: "",
    tonuOnly: false,
    warnings: [],
    milesPrinted: "192",
    paymentTermsText: "Net 21",
    detentionFreeMinutes: "120",
    detentionHourlyRate: "40"
  }
};
