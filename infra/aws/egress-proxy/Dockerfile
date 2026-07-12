FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache squid=6.12-r0

COPY squid.conf /etc/squid/squid.conf
COPY allowed-domains.txt /etc/squid/allowed-domains.txt

EXPOSE 3128

USER squid

CMD ["squid", "-NYCd", "1"]
