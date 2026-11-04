$env:DATABASE_URL="postgresql://demo:demo@localhost:54330/demo"
$env:BYPASS_AUTH="true"
node dispatch-desk/node_modules/next/dist/bin/next dev dispatch-desk/apps/web -p 3100
