import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import { WalletsModule } from '../wallets/wallets.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [WalletsModule, AuthModule],
  controllers: [InternalController],
  providers: [InternalApiKeyGuard],
})
export class InternalModule {}
