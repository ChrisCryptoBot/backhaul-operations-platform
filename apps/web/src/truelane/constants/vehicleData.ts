// VENDORED from TrueLane constants/vehicleData.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Static vehicle dataset: makes, models, years, and default specs.
 * Single source of truth for cascading Make -> Model -> Year picker and auto-fill.
 * No backend; works fully offline.
 */

/**
 * The one list of vehicle categories. The type, the runtime guard (`isVehicleCategory` in
 * lib/domain/fieldRelevance.ts) and every per-category map derive from or are checked against it
 * (lib/vehicleCategories.test.ts). Add or retire a category here, nowhere else.
 */
export const ALL_VEHICLE_CATEGORIES = [
  'cargo_van',
  'passenger_van',
  'pickup',
  'medium_duty',
  'heavy_duty',
  'box_truck',
  'sprinter',
] as const;

export type VehicleCategory = (typeof ALL_VEHICLE_CATEGORIES)[number];

export interface VehicleSpec {
  payloadLbs: number | null;
  maxLengthFt: number | null;
  maxWidthFt: number | null;
  maxHeightIn: number | null;
  heightInches: number | null;
  mpg: number | null;
  type: VehicleCategory;
}

export interface VehicleModelEntry {
  model: string;
  years: number[];
  specs: VehicleSpec;
}

export interface VehicleMakeEntry {
  make: string;
  models: VehicleModelEntry[];
}

export const VEHICLE_DATA: VehicleMakeEntry[] = [
  {
    make: 'Mercedes-Benz',
    models: [
      {
        model: 'Sprinter 1500 Cargo',
        years: [2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1764, maxLengthFt: 9.5, maxWidthFt: 4.7, maxHeightIn: 66, heightInches: 107, mpg: 20, type: 'cargo_van' },
      },
      {
        model: 'Sprinter 2500 Cargo (Standard Roof)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 2502, maxLengthFt: 11.2, maxWidthFt: 4.7, maxHeightIn: 66, heightInches: 111, mpg: 19, type: 'sprinter' },
      },
      {
        model: 'Sprinter 2500 Cargo (High Roof)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 2502, maxLengthFt: 11.2, maxWidthFt: 4.7, maxHeightIn: 78, heightInches: 123, mpg: 19, type: 'sprinter' },
      },
      {
        model: 'Sprinter 3500 Cargo (High Roof)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3307, maxLengthFt: 14.4, maxWidthFt: 4.7, maxHeightIn: 78, heightInches: 123, mpg: 17, type: 'sprinter' },
      },
      {
        model: 'Sprinter 3500XD Cargo',
        years: [2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4255, maxLengthFt: 14.4, maxWidthFt: 4.7, maxHeightIn: 78, heightInches: 123, mpg: 17, type: 'sprinter' },
      },
      {
        model: 'Metris Cargo',
        years: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
        specs: { payloadLbs: 1609, maxLengthFt: 6.0, maxWidthFt: 4.3, maxHeightIn: 47, heightInches: 72, mpg: 24, type: 'cargo_van' },
      },
    ],
  },
  {
    make: 'Ford',
    models: [
      {
        model: 'Transit 150 Cargo (Low Roof)',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1860, maxLengthFt: 9.8, maxWidthFt: 4.8, maxHeightIn: 56, heightInches: 100, mpg: 16, type: 'cargo_van' },
      },
      {
        model: 'Transit 250 Cargo (Medium Roof)',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3530, maxLengthFt: 12.7, maxWidthFt: 4.8, maxHeightIn: 71, heightInches: 110, mpg: 15, type: 'cargo_van' },
      },
      {
        model: 'Transit 350 Cargo (High Roof)',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4650, maxLengthFt: 14.9, maxWidthFt: 4.8, maxHeightIn: 81, heightInches: 126, mpg: 14, type: 'cargo_van' },
      },
      {
        model: 'Transit 350 HD Cargo (High Roof)',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 5050, maxLengthFt: 14.9, maxWidthFt: 4.8, maxHeightIn: 81, heightInches: 126, mpg: 13, type: 'cargo_van' },
      },
      {
        model: 'E-Series Econoline E-250',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014],
        specs: { payloadLbs: 3400, maxLengthFt: 10.0, maxWidthFt: 4.5, maxHeightIn: 54, heightInches: 84, mpg: 13, type: 'cargo_van' },
      },
      {
        model: 'E-Series Econoline E-350 (Extended)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014],
        specs: { payloadLbs: 4000, maxLengthFt: 12.5, maxWidthFt: 4.5, maxHeightIn: 54, heightInches: 84, mpg: 12, type: 'cargo_van' },
      },
      {
        model: 'Transit Connect (Cargo)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
        specs: { payloadLbs: 1600, maxLengthFt: 5.8, maxWidthFt: 4.0, maxHeightIn: 46, heightInches: 73, mpg: 28, type: 'cargo_van' },
      },
      {
        model: 'E-Transit Cargo 350 (High Roof)',
        years: [2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3800, maxLengthFt: 14.9, maxWidthFt: 4.8, maxHeightIn: 81, heightInches: 126, mpg: null, type: 'cargo_van' },
      },
      {
        model: 'F-650 Pro Loader (Box)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        // payloadLbs left blank: the number here was a GVWR, not a payload (F-650 GVWR is quoted 20,500–26,000 lb depending on source and body). Unverified, so not guessed.
        specs: { payloadLbs: null, maxLengthFt: 24.0, maxWidthFt: 8.0, maxHeightIn: 96, heightInches: 144, mpg: 11, type: 'medium_duty' },
      },
      {
        model: 'F-750',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        // payloadLbs left blank: the number here was a GVWR, not a payload (F-750 GVWR runs 30,200–37,000 lb). Unverified, so not guessed.
        specs: { payloadLbs: null, maxLengthFt: 28.0, maxWidthFt: 8.0, maxHeightIn: 96, heightInches: 152, mpg: 9, type: 'medium_duty' },
      },
      {
        model: 'F-150',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3325, maxLengthFt: 8.0, maxWidthFt: 4.2, maxHeightIn: 21, heightInches: 75, mpg: 20, type: 'pickup' },
      },
      {
        model: 'F-250 Super Duty',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4260, maxLengthFt: 8.0, maxWidthFt: 4.2, maxHeightIn: 21, heightInches: 81, mpg: 15, type: 'pickup' },
      },
      {
        model: 'F-350 Super Duty',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 7640, maxLengthFt: 8.0, maxWidthFt: 4.2, maxHeightIn: 21, heightInches: 81, mpg: 14, type: 'pickup' },
      },
      {
        model: 'Transit 350 Passenger Van (High Roof)',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3400, maxLengthFt: 14.9, maxWidthFt: 4.8, maxHeightIn: 81, heightInches: 126, mpg: 13, type: 'passenger_van' },
      },
    ],
  },
  {
    make: 'Ram',
    models: [
      {
        model: 'ProMaster 1500 Cargo (Low Roof)',
        years: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3040, maxLengthFt: 11.5, maxWidthFt: 4.8, maxHeightIn: 59, heightInches: 101, mpg: 18, type: 'cargo_van' },
      },
      {
        model: 'ProMaster 2500 Cargo (High Roof)',
        years: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4650, maxLengthFt: 14.7, maxWidthFt: 4.8, maxHeightIn: 74, heightInches: 115, mpg: 17, type: 'cargo_van' },
      },
      {
        model: 'ProMaster 3500 Cargo (High Roof, Extended)',
        years: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 5765, maxLengthFt: 17.7, maxWidthFt: 4.8, maxHeightIn: 74, heightInches: 115, mpg: 16, type: 'cargo_van' },
      },
      {
        model: 'ProMaster City Cargo',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022],
        specs: { payloadLbs: 1880, maxLengthFt: 5.4, maxWidthFt: 4.2, maxHeightIn: 45, heightInches: 73, mpg: 27, type: 'cargo_van' },
      },
      {
        model: '1500',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 2320, maxLengthFt: 6.3, maxWidthFt: 4.2, maxHeightIn: 21, heightInches: 77, mpg: 20, type: 'pickup' },
      },
      {
        model: '2500 Heavy Duty',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4010, maxLengthFt: 8.0, maxWidthFt: 4.2, maxHeightIn: 21, heightInches: 80, mpg: 15, type: 'pickup' },
      },
      {
        model: '3500 Heavy Duty',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 7680, maxLengthFt: 8.0, maxWidthFt: 4.2, maxHeightIn: 21, heightInches: 80, mpg: 14, type: 'pickup' },
      },
    ],
  },
  {
    make: 'Chevrolet',
    models: [
      {
        model: 'Express 1500 Cargo',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 2400, maxLengthFt: 10.5, maxWidthFt: 4.4, maxHeightIn: 54, heightInches: 81, mpg: 17, type: 'cargo_van' },
      },
      {
        model: 'Express 2500 Cargo',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3500, maxLengthFt: 10.5, maxWidthFt: 4.4, maxHeightIn: 54, heightInches: 81, mpg: 15, type: 'cargo_van' },
      },
      {
        model: 'Express 3500 Cargo (Extended)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4000, maxLengthFt: 13.5, maxWidthFt: 4.4, maxHeightIn: 54, heightInches: 81, mpg: 14, type: 'cargo_van' },
      },
      {
        model: 'Silverado 1500',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 2260, maxLengthFt: 8.0, maxWidthFt: 4.2, maxHeightIn: 22, heightInches: 75, mpg: 20, type: 'pickup' },
      },
      {
        model: 'Silverado 2500 HD',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3979, maxLengthFt: 8.2, maxWidthFt: 4.2, maxHeightIn: 22, heightInches: 79, mpg: 15, type: 'pickup' },
      },
      {
        model: 'Silverado 3500 HD',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 7442, maxLengthFt: 8.2, maxWidthFt: 4.2, maxHeightIn: 22, heightInches: 79, mpg: 14, type: 'pickup' },
      },
      {
        model: 'Express 3500 Passenger Van',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3500, maxLengthFt: 13.5, maxWidthFt: 4.4, maxHeightIn: 54, heightInches: 81, mpg: 14, type: 'passenger_van' },
      },
      {
        model: 'Kodiak C4500/C5500 (Box)',
        years: [1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009],
        specs: { payloadLbs: 10000, maxLengthFt: 24.0, maxWidthFt: 8.0, maxHeightIn: 102, heightInches: 156, mpg: 9, type: 'medium_duty' },
      },
    ],
  },
  {
    make: 'GMC',
    models: [
      {
        model: 'Savana 2500 Cargo',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 3500, maxLengthFt: 10.5, maxWidthFt: 4.4, maxHeightIn: 54, heightInches: 81, mpg: 15, type: 'cargo_van' },
      },
      {
        model: 'Savana 3500 Cargo (Extended)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 4000, maxLengthFt: 13.5, maxWidthFt: 4.4, maxHeightIn: 54, heightInches: 81, mpg: 14, type: 'cargo_van' },
      },
      {
        model: 'TopKick C4500/C5500 (Box)',
        years: [1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009],
        specs: { payloadLbs: 10000, maxLengthFt: 24.0, maxWidthFt: 8.0, maxHeightIn: 102, heightInches: 156, mpg: 9, type: 'medium_duty' },
      },
    ],
  },
  {
    make: 'Nissan',
    models: [
      {
        model: 'NV1500 Cargo (Standard Roof)',
        years: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021],
        specs: { payloadLbs: 2400, maxLengthFt: 9.2, maxWidthFt: 4.4, maxHeightIn: 48, heightInches: 80, mpg: 16, type: 'cargo_van' },
      },
      {
        model: 'NV2500 Cargo (High Roof)',
        years: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021],
        specs: { payloadLbs: 3100, maxLengthFt: 9.8, maxWidthFt: 4.4, maxHeightIn: 65, heightInches: 96, mpg: 14, type: 'cargo_van' },
      },
      {
        model: 'NV3500 Cargo (High Roof)',
        years: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021],
        specs: { payloadLbs: 3900, maxLengthFt: 9.8, maxWidthFt: 4.4, maxHeightIn: 65, heightInches: 96, mpg: 13, type: 'cargo_van' },
      },
      {
        model: 'NV200 Compact Cargo',
        years: [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021],
        specs: { payloadLbs: 1500, maxLengthFt: 6.2, maxWidthFt: 3.8, maxHeightIn: 47, heightInches: 73, mpg: 26, type: 'cargo_van' },
      },
    ],
  },
  {
    make: 'Toyota',
    models: [
      {
        model: 'Sienna (Passenger Van)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1240, maxLengthFt: 6.5, maxWidthFt: 3.9, maxHeightIn: 38, heightInches: 68, mpg: 28, type: 'passenger_van' },
      },
      {
        model: 'HiAce Cargo',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1984, maxLengthFt: 8.5, maxWidthFt: 4.4, maxHeightIn: 52, heightInches: 80, mpg: 22, type: 'cargo_van' },
      },
      {
        model: 'Tundra',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1940, maxLengthFt: 8.1, maxWidthFt: 4.1, maxHeightIn: 22, heightInches: 78, mpg: 18, type: 'pickup' },
      },
      {
        model: 'Tacoma',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1685, maxLengthFt: 6.0, maxWidthFt: 3.4, maxHeightIn: 19, heightInches: 70, mpg: 21, type: 'pickup' },
      },
    ],
  },
  {
    make: 'Honda',
    models: [
      {
        model: 'Odyssey (Passenger Van)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1057, maxLengthFt: 5.0, maxWidthFt: 3.8, maxHeightIn: 36, heightInches: 68, mpg: 28, type: 'passenger_van' },
      },
    ],
  },
  {
    make: 'Chrysler',
    models: [
      {
        model: 'Pacifica (Passenger Van)',
        years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 1500, maxLengthFt: 5.5, maxWidthFt: 3.8, maxHeightIn: 38, heightInches: 68, mpg: 30, type: 'passenger_van' },
      },
      {
        model: 'Town & Country',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016],
        specs: { payloadLbs: 1200, maxLengthFt: 5.0, maxWidthFt: 3.8, maxHeightIn: 38, heightInches: 68, mpg: 20, type: 'passenger_van' },
      },
    ],
  },
  {
    make: 'Isuzu',
    models: [
      {
        model: 'NPR (Box)',
        years: [2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 5540, maxLengthFt: 16.0, maxWidthFt: 7.8, maxHeightIn: 84, heightInches: 122, mpg: 16, type: 'medium_duty' },
      },
      {
        model: 'NPR-HD (Box)',
        years: [2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 8500, maxLengthFt: 18.0, maxWidthFt: 7.8, maxHeightIn: 84, heightInches: 122, mpg: 15, type: 'medium_duty' },
      },
      {
        model: 'NQR (Box)',
        years: [2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 12000, maxLengthFt: 20.0, maxWidthFt: 8.0, maxHeightIn: 90, heightInches: 130, mpg: 14, type: 'medium_duty' },
      },
      {
        model: 'NRR (Box)',
        years: [2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 14000, maxLengthFt: 24.0, maxWidthFt: 8.0, maxHeightIn: 90, heightInches: 135, mpg: 13, type: 'box_truck' },
      },
    ],
  },
  {
    make: 'Hino',
    models: [
      {
        model: '195h (Hybrid Box)',
        years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
        specs: { payloadLbs: 8600, maxLengthFt: 18.0, maxWidthFt: 7.8, maxHeightIn: 84, heightInches: 118, mpg: 18, type: 'medium_duty' },
      },
      {
        model: '258LP (Box)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 12000, maxLengthFt: 20.0, maxWidthFt: 8.0, maxHeightIn: 90, heightInches: 130, mpg: 13, type: 'medium_duty' },
      },
      {
        model: '268 (Box)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 16000, maxLengthFt: 24.0, maxWidthFt: 8.0, maxHeightIn: 96, heightInches: 138, mpg: 12, type: 'medium_duty' },
      },
      {
        model: '338 (Box)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 19000, maxLengthFt: 26.0, maxWidthFt: 8.0, maxHeightIn: 96, heightInches: 140, mpg: 11, type: 'medium_duty' },
      },
    ],
  },
  {
    make: 'International',
    models: [
      {
        model: 'MV Series (Box)',
        years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        // payloadLbs left blank: the number here was a GVWR, not a payload (box-truck GVWR is typically 26,000 lb, so 22,000 cannot be a payload). Unverified, so not guessed.
        specs: { payloadLbs: null, maxLengthFt: 26.0, maxWidthFt: 8.0, maxHeightIn: 96, heightInches: 148, mpg: 11, type: 'box_truck' },
      },
      {
        model: 'CV Series (Box)',
        years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 14000, maxLengthFt: 20.0, maxWidthFt: 8.0, maxHeightIn: 90, heightInches: 135, mpg: 12, type: 'medium_duty' },
      },
      {
        model: 'DuraStar (4300 Box)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018],
        specs: { payloadLbs: 20000, maxLengthFt: 24.0, maxWidthFt: 8.0, maxHeightIn: 96, heightInches: 140, mpg: 10, type: 'medium_duty' },
      },
      {
        model: 'LT Series (Sleeper)',
        years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 162, mpg: 7, type: 'heavy_duty' },
      },
      {
        model: 'ProStar (Sleeper)',
        years: [2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 162, mpg: 6, type: 'heavy_duty' },
      },
    ],
  },
  {
    make: 'Freightliner',
    models: [
      {
        model: 'Cascadia (Sleeper)',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 162, mpg: 8, type: 'heavy_duty' },
      },
      {
        model: 'Cascadia Day Cab',
        years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 145, mpg: 8, type: 'heavy_duty' },
      },
      {
        model: 'M2 106 (Box)',
        years: [2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        // payloadLbs left blank: the number here was a GVWR, not a payload (GVWR 26,000 lb; payload depends on the body (a 24 ft box is roughly 12,000 lb)). Unverified, so not guessed.
        specs: { payloadLbs: null, maxLengthFt: 26.0, maxWidthFt: 8.0, maxHeightIn: 102, heightInches: 148, mpg: 10, type: 'box_truck' },
      },
      {
        model: 'Century Class / Columbia (Sleeper)',
        years: [1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010],
        specs: { payloadLbs: 47000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 156, mpg: 6.5, type: 'heavy_duty' },
      },
      {
        model: 'MT45 / MT55 Step Van',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 10000, maxLengthFt: 22.0, maxWidthFt: 7.75, maxHeightIn: 85, heightInches: 124, mpg: 11, type: 'box_truck' },
      },
      {
        model: 'eCascadia (Electric)',
        years: [2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 162, mpg: null, type: 'heavy_duty' },
      },
    ],
  },
  {
    make: 'Kenworth',
    models: [
      {
        model: 'T680 (Sleeper)',
        years: [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 160, mpg: 8, type: 'heavy_duty' },
      },
      {
        model: 'T660 (Sleeper)',
        years: [2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 160, mpg: 6, type: 'heavy_duty' },
      },
      {
        model: 'T680E (Electric Sleeper)',
        years: [2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 160, mpg: null, type: 'heavy_duty' },
      },
      {
        model: 'T880 (Sleeper)',
        years: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 48000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 165, mpg: 7, type: 'heavy_duty' },
      },
      {
        model: 'T800 (Heavy Haul / Day Cab)',
        years: [1986, 1987, 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
        specs: { payloadLbs: 48000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 150, mpg: 6, type: 'heavy_duty' },
      },
      {
        model: 'W900 (Sleeper)',
        years: [1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 165, mpg: 5, type: 'heavy_duty' },
      },
    ],
  },
  {
    make: 'Peterbilt',
    models: [
      {
        model: '579 (Sleeper)',
        years: [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 161, mpg: 8, type: 'heavy_duty' },
      },
      {
        model: '389 (Sleeper)',
        years: [2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 164, mpg: 7, type: 'heavy_duty' },
      },
      {
        model: '379 (Sleeper)',
        years: [1987, 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 138, mpg: 6, type: 'heavy_duty' },
      },
      {
        model: '386 (Sleeper)',
        years: [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 160, mpg: 6, type: 'heavy_duty' },
      },
      {
        model: '567 (Vocational)',
        years: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 40000, maxLengthFt: 48.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 158, mpg: 7, type: 'heavy_duty' },
      },
    ],
  },
  {
    make: 'Volvo',
    models: [
      {
        model: 'VNL 760 (Sleeper)',
        years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 159, mpg: 8, type: 'heavy_duty' },
      },
      {
        model: 'VNL 670 (Sleeper)',
        years: [2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 159, mpg: 6, type: 'heavy_duty' },
      },
      {
        model: 'VNR Day Cab',
        years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 145, mpg: 7, type: 'heavy_duty' },
      },
    ],
  },
  {
    make: 'Mack',
    models: [
      {
        model: 'Anthem 64T (Sleeper)',
        years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 160, mpg: 8, type: 'heavy_duty' },
      },
      {
        model: 'Pinnacle (Sleeper)',
        years: [2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 45000, maxLengthFt: 53.0, maxWidthFt: 8.5, maxHeightIn: 110, heightInches: 161, mpg: 7, type: 'heavy_duty' },
      },
    ],
  },
  {
    make: 'Workhorse',
    models: [
      {
        model: 'P-Series Step Van',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
        specs: { payloadLbs: 10000, maxLengthFt: 22.0, maxWidthFt: 7.75, maxHeightIn: 86, heightInches: 125, mpg: 9, type: 'box_truck' },
      },
    ],
  },
  {
    make: 'Iveco',
    models: [
      {
        model: 'Daily (Large Cargo Van)',
        years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
        specs: { payloadLbs: 5000, maxLengthFt: 16.8, maxWidthFt: 6.0, maxHeightIn: 83, heightInches: 116, mpg: 27, type: 'cargo_van' },
      },
    ],
  },
  {
    make: 'Other / Custom',
    models: [
      {
        model: 'Custom Vehicle',
        years: [],
        specs: { payloadLbs: null, maxLengthFt: null, maxWidthFt: null, maxHeightIn: null, heightInches: null, mpg: null, type: 'cargo_van' },
      },
    ],
  },
];

/** Returns a sorted list of all unique makes */
export function getMakes(): string[] {
  return VEHICLE_DATA.map((entry) => entry.make).sort();
}

/** Returns models for a given make */
export function getModels(make: string): VehicleModelEntry[] {
  return VEHICLE_DATA.find((entry) => entry.make === make)?.models ?? [];
}

/** Returns available years for a given make + model, sorted descending (newest first) */
export function getYears(make: string, modelName: string): number[] {
  const modelEntry = getModels(make).find((m) => m.model === modelName);
  if (!modelEntry) return [];
  return [...modelEntry.years].sort((a, b) => b - a);
}

/** Returns the specs for a given make + model (year does not change specs in this dataset) */
export function getSpecs(make: string, modelName: string): VehicleSpec | null {
  return getModels(make).find((m) => m.model === modelName)?.specs ?? null;
}

/**
 * The types the vehicle picker offers. `medium_duty` is not one of them: it was merged into Box Truck (a
 * medium-duty truck here is a straight box truck, and no load board lists "medium duty"). It stays in
 * `VehicleCategory` so stored rows and dataset models keep working; every consumer treats it as a box truck.
 */
export const PICKER_VEHICLE_CATEGORIES: readonly VehicleCategory[] = [
  'cargo_van',
  'passenger_van',
  'pickup',
  'sprinter',
  'box_truck',
  'heavy_duty',
];

/** Retired type values and what they mean now. Read-only: stored rows are not rewritten. */
const LEGACY_VEHICLE_TYPE_ALIASES: Readonly<Record<string, VehicleCategory>> = { medium_duty: 'box_truck' };

/** A stored type with any retired value mapped to its current one; null for missing or blank. Unknown values pass through. */
export function canonicalVehicleType(type: string | null | undefined): string | null {
  const t = type?.trim();
  if (!t) return null;
  return LEGACY_VEHICLE_TYPE_ALIASES[t] ?? t;
}

/** Maps VehicleCategory to the string value stored in WatermelonDB Vehicle.type (retired values become their current type). */
export function categoryToDbType(category: VehicleCategory): VehicleCategory {
  return LEGACY_VEHICLE_TYPE_ALIASES[category] ?? category;
}

/** Closed numeric range used for helper copy and deriving industry default midpoints. */
export type NumericBand = readonly [number, number];

/**
 * Industry bands + discrete defaults for Cost Profile wizard hydration / "restore defaults".
 * - `typical*` bands drive placeholder/helper text (unchanged keys for existing UI).
 * - `default*` values are intentional midpoints (or rounded) for non-zero floors on first open.
 */
export type VehicleCategoryPreset = {
  typicalMpg: NumericBand;
  typicalInsurance: NumericBand;
  typicalMaintenanceCpm: NumericBand;
  /** Typical tire reserve band ($/mi) for helper copy */
  typicalTireCpm: NumericBand;
  /** Typical monthly miles band for helper copy */
  typicalEstimatedMonthlyMiles: NumericBand;
  /** MPG fallback when `vehicles.mpg` is null (wizard / calculator hints) */
  defaultMpg: number;
  /** Seeds `monthly_insurance` / liability bucket when profile is empty */
  defaultTotalInsuranceMonthly: number;
  defaultMaintenanceCpm: number;
  defaultTireCpm: number;
  defaultEstimatedMonthlyMiles: number;
  /** Baseline operating fixed costs (MC number, ELD, UCR, etc.) — adjust as product copy evolves */
  defaultMonthlyAuthority: number;
  /** Phone + subscriptions lump baseline */
  defaultMonthlyPhoneSubscriptions: number;
};

const DEFAULT_MONTHLY_AUTHORITY = 99;
const DEFAULT_MONTHLY_PHONE_SUBSCRIPTIONS = 125;

function bandMid(band: NumericBand): number {
  return (band[0] + band[1]) / 2;
}

function buildVehicleCategoryPreset(
  bands: Pick<
    VehicleCategoryPreset,
    | 'typicalMpg'
    | 'typicalInsurance'
    | 'typicalMaintenanceCpm'
    | 'typicalTireCpm'
    | 'typicalEstimatedMonthlyMiles'
  >,
  overrides?: Partial<
    Pick<
      VehicleCategoryPreset,
      | 'defaultMpg'
      | 'defaultTotalInsuranceMonthly'
      | 'defaultMaintenanceCpm'
      | 'defaultTireCpm'
      | 'defaultEstimatedMonthlyMiles'
      | 'defaultMonthlyAuthority'
      | 'defaultMonthlyPhoneSubscriptions'
    >
  >
): VehicleCategoryPreset {
  return {
    ...bands,
    defaultMpg: overrides?.defaultMpg ?? bandMid(bands.typicalMpg),
    defaultTotalInsuranceMonthly:
      overrides?.defaultTotalInsuranceMonthly ?? bandMid(bands.typicalInsurance),
    defaultMaintenanceCpm: overrides?.defaultMaintenanceCpm ?? bandMid(bands.typicalMaintenanceCpm),
    defaultTireCpm: overrides?.defaultTireCpm ?? bandMid(bands.typicalTireCpm),
    defaultEstimatedMonthlyMiles:
      overrides?.defaultEstimatedMonthlyMiles ?? Math.round(bandMid(bands.typicalEstimatedMonthlyMiles)),
    defaultMonthlyAuthority: overrides?.defaultMonthlyAuthority ?? DEFAULT_MONTHLY_AUTHORITY,
    defaultMonthlyPhoneSubscriptions:
      overrides?.defaultMonthlyPhoneSubscriptions ?? DEFAULT_MONTHLY_PHONE_SUBSCRIPTIONS,
  };
}

/** Pre-filled typical ranges + hydration defaults based on vehicle type */
export const VEHICLE_PRESETS: Record<VehicleCategory, VehicleCategoryPreset> = {
  cargo_van: buildVehicleCategoryPreset({
    typicalMpg: [15, 20],
    typicalInsurance: [150, 300],
    typicalMaintenanceCpm: [0.08, 0.12],
    typicalTireCpm: [0.03, 0.07],
    typicalEstimatedMonthlyMiles: [5000, 9000],
  }),
  passenger_van: buildVehicleCategoryPreset({
    typicalMpg: [18, 25],
    typicalInsurance: [150, 300],
    typicalMaintenanceCpm: [0.08, 0.12],
    typicalTireCpm: [0.03, 0.07],
    typicalEstimatedMonthlyMiles: [5000, 9000],
  }),
  pickup: buildVehicleCategoryPreset({
    typicalMpg: [12, 18],
    typicalInsurance: [150, 300],
    typicalMaintenanceCpm: [0.1, 0.15],
    typicalTireCpm: [0.04, 0.08],
    typicalEstimatedMonthlyMiles: [5000, 9000],
  }),
  sprinter: buildVehicleCategoryPreset({
    typicalMpg: [15, 20],
    typicalInsurance: [200, 400],
    typicalMaintenanceCpm: [0.1, 0.15],
    typicalTireCpm: [0.04, 0.1],
    typicalEstimatedMonthlyMiles: [6000, 10000],
  }),
  box_truck: buildVehicleCategoryPreset({
    typicalMpg: [10, 14],
    typicalInsurance: [300, 600],
    typicalMaintenanceCpm: [0.12, 0.18],
    typicalTireCpm: [0.08, 0.14],
    typicalEstimatedMonthlyMiles: [6000, 10000],
  }),
  medium_duty: buildVehicleCategoryPreset({
    typicalMpg: [8, 12],
    typicalInsurance: [400, 800],
    typicalMaintenanceCpm: [0.15, 0.25],
    typicalTireCpm: [0.1, 0.18],
    typicalEstimatedMonthlyMiles: [7000, 11000],
  }),
  heavy_duty: buildVehicleCategoryPreset({
    typicalMpg: [6, 9],
    typicalInsurance: [500, 1200],
    typicalMaintenanceCpm: [0.2, 0.4],
    typicalTireCpm: [0.15, 0.28],
    typicalEstimatedMonthlyMiles: [8000, 12000],
  }),
};

export function getVehicleCategoryPreset(category: VehicleCategory): VehicleCategoryPreset {
  return VEHICLE_PRESETS[category];
}

/** String values for Cost Profile wizard hydration / "Restore industry defaults". */
export type CostProfileIndustryHydrationStrings = {
  monthlyInsurance: string;
  monthlyAuthority: string;
  monthlyPhoneSubscriptions: string;
  estimatedMonthlyMiles: string;
  maintenanceReservePerMile: string;
  tireReservePerMile: string;
};

function trimPresetDecimalString(n: number): string {
  const s = n.toFixed(4).replace(/\.?0+$/, '');
  return s.length > 0 ? s : '0';
}

export function getCostProfileIndustryHydrationStrings(
  category: VehicleCategory
): CostProfileIndustryHydrationStrings {
  const pr = getVehicleCategoryPreset(category);
  return {
    monthlyInsurance: String(Math.round(pr.defaultTotalInsuranceMonthly * 100) / 100),
    monthlyAuthority: String(pr.defaultMonthlyAuthority),
    monthlyPhoneSubscriptions: String(pr.defaultMonthlyPhoneSubscriptions),
    estimatedMonthlyMiles: String(pr.defaultEstimatedMonthlyMiles),
    maintenanceReservePerMile: trimPresetDecimalString(pr.defaultMaintenanceCpm),
    tireReservePerMile: trimPresetDecimalString(pr.defaultTireCpm),
  };
}
