-- What a notification said, in a line, so the desk can show what went out (or what the demo desk would have sent). Never a body, a key or an address.
ALTER TABLE "notification_log" ADD COLUMN "subject" TEXT;
