# Deployment

`deploy/manual/deploy.sh` is the one-command production deployment entry point. It publishes the Web app to `/var/www/ai-murder-mystery`, starts the API on loopback using a PID file and `nohup`, and installs the project-only Nginx configuration for `ai-murder-mystery.robinverse.me`.

The deployment does not use systemd. It validates Nginx with `nginx -t` and reloads it with `nginx -s reload`. The certificate files are expected at `/etc/nginx/ssl/robinverse.me.pem` and `/etc/nginx/ssl/robinverse.me.key`; the certificate must cover the configured domain.

The API is not automatically restarted after a host reboot. This is an intentional limitation of the no-systemd deployment model.
