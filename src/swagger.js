const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Compliance Guard API',
      version: '1.0.0',
      description: 'Backend API for Compliance Guard web scraping and evidence collection system',
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', format: 'email', example: 'john@example.com' },
            role: { type: 'string', enum: ['Admin', 'Analyst'], example: 'Analyst' },
            status: { type: 'string', enum: ['Active', 'Inactive'], example: 'Active' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Task: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            search_query: { type: 'string', example: 'compliance regulation - page 1' },
            target_url: { type: 'string', example: 'https://www.google.com/search?q=compliance+regulation&page=1' },
            status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'], example: 'PENDING' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Evidence: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            search_query: { type: 'string', example: 'compliance regulation - page 1' },
            target_url: { type: 'string', example: 'https://www.google.com/search?q=compliance+regulation&page=1' },
            screenshot_path: { type: 'string', example: '/storage/screenshots/task_1.png' },
            completed_at: { type: 'string', format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        QueueStatus: {
          type: 'object',
          properties: {
            PENDING: { type: 'integer', example: 5 },
            PROCESSING: { type: 'integer', example: 2 },
            COMPLETED: { type: 'integer', example: 10 },
            FAILED: { type: 'integer', example: 1 },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Error message' },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.js', './src/index.js'],
};

const swaggerSpec = swaggerJSDoc(options);

module.exports = { swaggerUi, swaggerSpec };
