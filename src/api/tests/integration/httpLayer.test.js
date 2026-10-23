/* eslint-disable arrow-body-style */
const request = require('supertest');
const httpStatus = require('http-status');
const { expect } = require('chai');
const app = require('../../../index');
const User = require('../../models/user.model');

describe('HTTP layer', () => {
  before(() => app.started);

  beforeEach(async () => {
    await User.deleteMany({});
  });

  describe('GET /v1/status', () => {
    it('should answer OK as html', () => {
      return request(app.server)
        .get('/v1/status')
        .expect(httpStatus.OK)
        .then((res) => {
          expect(res.headers['content-type']).to.match(/^text\/html/);
          expect(res.text).to.be.equal('OK');
        });
    });
  });

  describe('unmatched requests', () => {
    it('should report a not found error for an unknown path', () => {
      return request(app.server)
        .get('/v1/does-not-exist')
        .expect(httpStatus.NOT_FOUND)
        .then((res) => {
          expect(res.body.code).to.be.equal(404);
          expect(res.body.message).to.be.equal('Not found');
          expect(res.body).to.not.have.a.property('stack');
        });
    });

    it('should report a not found error when the method does not match', () => {
      return request(app.server)
        .get('/v1/auth/register')
        .expect(httpStatus.NOT_FOUND)
        .then((res) => {
          expect(res.body.code).to.be.equal(404);
          expect(res.body.message).to.be.equal('Not found');
        });
    });
  });

  describe('request body parsing', () => {
    it('should validate against an empty body when no body is sent', () => {
      return request(app.server)
        .post('/v1/auth/register')
        .expect(httpStatus.BAD_REQUEST)
        .then((res) => {
          const fields = res.body.errors.map((e) => e.field);
          expect(res.body.message).to.be.equal('Validation Error');
          expect(fields).to.include('email');
          expect(fields).to.include('password');
        });
    });

    it('should validate against an empty body when the content type is not json', () => {
      return request(app.server)
        .post('/v1/auth/register')
        .set('Content-Type', 'text/plain')
        .send('email=notjson@example.com')
        .expect(httpStatus.BAD_REQUEST)
        .then((res) => {
          const { field, location, messages } = res.body.errors[0];
          expect(field).to.be.equal('email');
          expect(location).to.be.equal('body');
          expect(messages).to.include('"email" is required');
        });
    });

    it('should report a bad request error when the json body is malformed', () => {
      return request(app.server)
        .post('/v1/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(httpStatus.BAD_REQUEST)
        .then((res) => {
          expect(res.body.code).to.be.equal(400);
        });
    });

    it('should accept a urlencoded body', () => {
      return request(app.server)
        .post('/v1/auth/register')
        .type('form')
        .send({ email: 'urlencoded@example.com', password: '123456' })
        .expect(httpStatus.CREATED)
        .then((res) => {
          expect(res.body.user.email).to.be.equal('urlencoded@example.com');
        });
    });
  });

  describe('method override', () => {
    it('should route the request with the overridden method', () => {
      return request(app.server)
        .post('/v1/status')
        .set('X-HTTP-Method-Override', 'GET')
        .expect(httpStatus.OK)
        .then((res) => {
          expect(res.text).to.be.equal('OK');
        });
    });

    it('should report a not found error without the override header', () => {
      return request(app.server)
        .post('/v1/status')
        .expect(httpStatus.NOT_FOUND);
    });
  });

  describe('cross origin requests', () => {
    it('should answer an options request without preflight headers', () => {
      return request(app.server)
        .options('/v1/status')
        .expect(httpStatus.NO_CONTENT);
    });

    it('should allow any origin', () => {
      return request(app.server)
        .get('/v1/status')
        .set('Origin', 'https://example.com')
        .expect(httpStatus.OK)
        .then((res) => {
          expect(res.headers['access-control-allow-origin']).to.be.equal('*');
        });
    });
  });
});
