/** Small source checks shared by the telematics tests (not a test file itself). */
export const ELD_RULES = {
  /** The normalizer must keep speed and heading: they were in the payload from the start and were being thrown away. */
  keepsSpeedAndHeading: (motiveSource: string) => /speedMph: place\.speed/.test(motiveSource) && /headingDeg: place\.bearing/.test(motiveSource)
};
