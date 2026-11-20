import React from 'react';
import ReactUnity from '@reactunity/renderer';
import { App } from './App';

ReactUnity.render(<App />, { disableBatchRendering: true });
