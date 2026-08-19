-- DAT service-account credentials (alternative to a single token). Additive.
ALTER TABLE "DatProviderConfig" ADD COLUMN "usernameCipher" TEXT;
ALTER TABLE "DatProviderConfig" ADD COLUMN "passwordCipher" TEXT;
ALTER TABLE "DatProviderConfig" ADD COLUMN "userEmail" TEXT;
