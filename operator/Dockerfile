# Build context is the operator/ directory: docker build operator/
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /manager .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /manager /manager
USER 65532:65532
ENTRYPOINT ["/manager"]
