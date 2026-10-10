FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html use-cases.html download.html resources.html /usr/share/nginx/html/
# The App Store listing for the Selfnote app points at /support.html and /privacy.html.
COPY privacy.html support.html /usr/share/nginx/html/
COPY articles /usr/share/nginx/html/articles
COPY docs /usr/share/nginx/html/docs
# The App Store listing points at /ereader/support.html and /ereader/privacy.html, so
# these two must ship with the site or the listing's required URLs 404.
COPY ereader /usr/share/nginx/html/ereader
COPY assets /usr/share/nginx/html/assets
