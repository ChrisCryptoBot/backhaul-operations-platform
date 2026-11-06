#!/usr/bin/env sh
# After applying the SQL by hand: record every desk migration in Prisma's own history so "prisma migrate deploy" has nothing left to run.
# Run from dispatch-desk with DATABASE_URL pointing at the desk's database (the direct connection, port 5432).
# 20261028010000_retire_legacy_dispatch_tables is marked applied without being run: it is for a database that still has the old tables, and a fresh one never did.
set -e
for m in \
  20261028000000_truelane_shaped_models \
  20261028010000_retire_legacy_dispatch_tables \
  20261029000000_audit_events \
  20261029010000_workspace_thresholds \
  20261030000000_cost_profile_targets_driver_pay \
  20261031000000_load_details_and_invoice_lines \
  20261101000000_driver_settlements \
  20261102000000_loaded_hours \
  20261103000000_company_and_payment \
  20261104000000_vehicle_equipment \
  20261105000000_vehicle_home_coordinates \
  20261106000000_customers \
  20261106100000_scale_indexes_terminals \
  20261106200000_trailers \
  20261107000000_partner_seams \
  20261108000000_messages \
  20261108100000_signup_requests \
  20261108200000_message_attachments \
  20261109000000_plan_default_and_check \
  20261110000000_members \
  20261111000000_load_documents \
  20261112000000_load_payments \
  20261113000000_service_usage \
  20261114000000_card_lane_thresholds \
  20261115000000_quote_extras \
  20261116000000_quote_decision_details \
  20261117000000_load_write_off \
  20261118000000_loads_phone_parity \
  20261119000000_accounting_role \
  20261119000100_statement_paid_and_indexes \
  20261120000000_driver_link \
  20261121000000_workspace_timezone \
  20261122000000_partner_backbone \
  20261123000000_eld_telemetry \
  20261124000000_ifta_store \
  20261125000000_partner_data \
  20261126000000_fuel_deduction \
  20261127000000_driver_shifts \
  20261128000000_telematics_radar \
  20261130000000_kpi_targets_notes \
  20261201000000_asset_history \
  20261202000000_regions_scope \
  20261203000000_imported_history \
  20261204000000_signals \
  20261205000000_notification_subject; do
  npx prisma migrate resolve --applied "$m" --schema=./prisma/schema.prisma
done
