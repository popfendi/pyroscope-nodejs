import { URL } from 'node:url';

import { encode } from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { ProfileExport, ProfileExporter } from './profile-exporter.js';
import { dateToUnixTimestamp } from './utils/date-to-unix-timestamp.js';
import { processProfile } from './utils/process-profile.js';
import debug from 'debug';
import { PyroscopeConfig } from './pyroscope-config.js';
import {Blob as BlobPolyfill} from 'node:buffer';

global.Blob = BlobPolyfill as any;

const log = debug('pyroscope');

export class PyroscopeApiExporter implements ProfileExporter {
  private readonly applicationName: string;
  private readonly authToken: string | undefined;
  private readonly serverAddress: string;
  private readonly config: PyroscopeConfig;

  constructor(
    applicationName: string,
    authToken: string | undefined,
    serverAddress: string,
    config: PyroscopeConfig
  ) {
    this.applicationName = applicationName;
    this.authToken = authToken;
    this.serverAddress = serverAddress;
    this.config = config;
  }

  public async export(profileExport: ProfileExport): Promise<void> {
    await this.uploadProfile(profileExport);
  }

  private buildEndpointUrl(profileExport: ProfileExport): URL {
    const endpointUrl: URL = new URL(`${this.serverAddress}/ingest`);

    endpointUrl.searchParams.append(
      'from',
      dateToUnixTimestamp(profileExport.startedAt).toString()
    );
    endpointUrl.searchParams.append('name', this.applicationName);
    endpointUrl.searchParams.append('spyName', 'nodespy');
    endpointUrl.searchParams.append(
      'until',
      dateToUnixTimestamp(profileExport.stoppedAt).toString()
    );

    if (profileExport.sampleRate !== undefined) {
      endpointUrl.searchParams.append(
        'sampleRate',
        profileExport.sampleRate.toString()
      );
    }

    return endpointUrl;
  }

  private buildRequestHeaders(): Headers {
    const headers: Headers = new Headers();

    if (this.authToken !== undefined) {
      headers.set('authorization', `Bearer ${this.authToken}`);
    } else if (this.config.basicAuthUser && this.config.basicAuthPassword) {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(
          `${this.config.basicAuthUser}:${this.config.basicAuthPassword}`
        ).toString('base64')}`
      );
    }

    if (this.config.tenantID) {
      headers.set('X-Scope-OrgID', this.config.tenantID);
    }

    return headers;
  }

  private async buildUploadProfileFormData(
    profile: Profile
  ): Promise<FormData> {
    const processedProfile: Profile = processProfile(profile);

    const profileBuffer: Buffer = await encode(processedProfile);

    const formData: FormData = new FormData();

    /*
     * Use the raw Buffer rather than wrapping it in a Blob. In environments
     * where `fetch` is poly-filled by libraries such as `node-fetch`, the Blob
     * implementation is not always recognised which can result in the whole
     * FormData object being coerced to the string "[object FormData]". By
     * passing the Buffer directly we ensure both the built-in `undici` fetch
     * (Node >= 18) and the `node-fetch` polyfill serialise the multipart body
     * correctly.
     */
    // TS DOM lib does not include Buffer in the overload list, but both
    // `undici` (built-in fetch in Node >= 18) and `node-fetch` understand a
    // `Buffer` value here, so we cast to `any` to satisfy the compiler.
    formData.append('profile', profileBuffer as any, 'profile');

    return formData;
  }

  private async uploadProfile(profileExport: ProfileExport): Promise<void> {
    const formData: FormData = await this.buildUploadProfileFormData(
      profileExport.profile
    );

    try {
      const response = await fetch(
        this.buildEndpointUrl(profileExport).toString(),
        {
          body: formData,
          headers: this.buildRequestHeaders(),
          method: 'POST',
        }
      );

      if (!response.ok) {
        log('Server rejected data ingest: HTTP %d', response.status);
        log(await response.text());
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        log('Error sending data ingest: %s', error.message);
      } else {
        log('Unknown error sending data ingest');
      }
    }
  }
}
