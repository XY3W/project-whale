FROM node:18-alpine
WORKDIR /app
COPY server.mjs .
COPY dist ./html
EXPOSE 8080
CMD ["node", "server.mjs"]
