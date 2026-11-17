import { describe, it, expect } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, getDynamoDbDocumentClient } from './aws-clients.js';

describe('DynamoDB client getters', () => {
  it('memoizes one DynamoDBClient per process', () => {
    expect(getDynamoDbClient()).toBeInstanceOf(DynamoDBClient);
    expect(getDynamoDbClient()).toBe(getDynamoDbClient());
  });

  it('memoizes one DocumentClient that strips undefined optional fields', async () => {
    const doc = getDynamoDbDocumentClient();
    expect(doc).toBeInstanceOf(DynamoDBDocumentClient);
    expect(doc).toBe(getDynamoDbDocumentClient());
    expect(doc.config.translateConfig?.marshallOptions?.removeUndefinedValues).toBe(true);
  });
});
