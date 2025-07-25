import { URL } from 'node:url';

import { encode } from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { ProfileExport, ProfileExporter } from './profile-exporter.js';
import { dateToUnixTimestamp } from './utils/date-to-unix-timestamp.js';
import { processProfile } from './utils/process-profile.js';
import debug from 'debug';
import { PyroscopeConfig } from './pyroscope-config.js'; 

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
  ): Promise<Buffer> {
    const processedProfile: Profile = processProfile(profile);

    const profileBuffer: Buffer = await encode(processedProfile);

    return profileBuffer;
  }

  private async uploadProfile(profileExport: ProfileExport): Promise<void> {
    const profile: Buffer = await this.buildUploadProfileFormData(
      profileExport.profile
    );

    const boundary = 'pyroscope-boundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="profile"; filename="profile"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ),
      profile,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const headers = this.buildRequestHeaders();
    headers.set('Content-Type', `multipart/form-data; boundary=${boundary}`);

    log('Request body:', body);
    try {
      const response = await fetch(
        this.buildEndpointUrl(profileExport).toString(),
        {
          body,
          headers: headers,
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
