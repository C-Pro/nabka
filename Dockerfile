# Stage 1: Build binary using vendored dependencies
FROM golang:1.27-alpine AS builder

WORKDIR /build

# Install CA certificates and timezone data
RUN apk --no-cache add ca-certificates tzdata

# Create an unprivileged user (UID 10001)
RUN adduser -D -g '' -u 10001 -h /tmp appuser

# Copy source tree including vendor directory
COPY . .

# Build statically-linked binary from vendor without network access
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -mod=vendor \
    -trimpath \
    -ldflags="-s -w -extldflags '-static'" \
    -o /nabka-server \
    ./cmd/server

# Stage 2: Minimal runtime image from scratch
FROM scratch

# Copy root CA certificates and timezone data
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Copy user definition for non-root execution
COPY --from=builder /etc/passwd /etc/passwd

# Copy statically linked application binary
COPY --from=builder /nabka-server /nabka-server

# Run as non-root user
USER 10001:10001

# Default port
EXPOSE 8080

ENTRYPOINT ["/nabka-server"]
