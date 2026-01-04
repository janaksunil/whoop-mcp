# Use official Bun image
FROM oven/bun:1-alpine

# Set working directory
WORKDIR /app

# Copy all files
COPY . .

# Install dependencies
RUN bun install --production

# Expose the default port
EXPOSE 3000

# Run the application
CMD ["bun", "run", "index.ts"]

