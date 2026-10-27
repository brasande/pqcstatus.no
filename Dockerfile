FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN go vet ./... && CGO_ENABLED=0 go build -o /kvantesjekk ./cmd/kvantesjekk

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /kvantesjekk /usr/local/bin/kvantesjekk
WORKDIR /app
ENTRYPOINT ["kvantesjekk"]
