import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { UpstreamUnavailableError } from './upstream.client';

@Catch(UpstreamUnavailableError)
export class UpstreamUnavailableFilter implements ExceptionFilter {
  catch(err: UpstreamUnavailableError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: `${err.upstream}-service тимчасово недоступний, спробуйте пізніше`,
      });
  }
}
