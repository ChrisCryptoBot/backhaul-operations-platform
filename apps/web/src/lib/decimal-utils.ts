import { Prisma } from "@prisma/client";

export function safeDivideDecimal(numerator: Prisma.Decimal, denominator: Prisma.Decimal): Prisma.Decimal | null {
  if (denominator.equals(0)) {
    return null;
  }
  return numerator.div(denominator);
}
