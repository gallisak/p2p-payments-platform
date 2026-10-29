import { Module } from '@nestjs/common';
import { EmailNormalizer } from './email-normalizer';

@Module({
  providers: [EmailNormalizer],
})
export class EmailNormalizationModule {}
